import { Logger } from './Logger';

export type JSONRecord = Record<string, unknown>;

export class APIError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class HTTP {
  private static readonly logger = Logger.forModule('relay.http');
  static async json(request: Request): Promise<JSONRecord> {
    if (!request.headers.get('content-type')?.includes('application/json')) {
      throw new APIError(415, 'invalid_content_type', 'JSON request body required.');
    }

    let data: unknown;
    try {
      data = await request.json();
    } catch {
      throw new APIError(400, 'invalid_json', 'Request body must contain valid JSON.');
    }

    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new APIError(400, 'invalid_request', 'Request body must be a JSON object.');
    }

    return data as JSONRecord;
  }

  static requiredString(data: JSONRecord, key: string, maxLength = 4096): string {
    const value = data[key];

    if (typeof value !== 'string' || !value.trim() || value.trim().length > maxLength) {
      throw new APIError(400, 'invalid_request', `${key} must be a nonempty string of at most ${maxLength} characters.`);
    }

    return value.trim();
  }

  static optionalString(data: JSONRecord, key: string, maxLength = 4096): string | null {
    const value = data[key];

    if (value === undefined || value === null) {
      return null;
    }

    if (typeof value !== 'string' || value.length > maxLength) {
      throw new APIError(400, 'invalid_request', `${key} must be a string of at most ${maxLength} characters.`);
    }

    return value.trim() || null;
  }

  static artifacts(data: JSONRecord): string[] {
    const value = data.artifactLinks;

    if (value === undefined) {
      return [];
    }

    if (!Array.isArray(value) || value.length > 20) {
      throw new APIError(400, 'invalid_artifact_links', 'artifactLinks must be an array of at most 20 HTTPS URLs.');
    }

    return value.map((entry) => {
      if (typeof entry !== 'string' || entry.length > 2048) {
        throw new APIError(400, 'invalid_artifact_links', 'Each artifact link must be a URL string.');
      }

      if (!URL.canParse(entry)) {
        throw new APIError(400, 'invalid_artifact_links', 'Each artifact link must be a valid HTTPS URL.');
      }

      const url = new URL(entry);

      if (url.protocol !== 'https:') {
        throw new APIError(400, 'invalid_artifact_links', 'Only HTTPS artifact links are supported.');
      }

      return url.toString();
    });
  }

  static response(data: unknown, status = 200): Response {
    return Response.json({ ok: true, data }, { status });
  }

  static error(error: unknown): Response {
    if (error instanceof APIError) {
      return Response.json(
        { ok: false, error: { code: error.code, message: error.message } },
        { status: error.status },
      );
    }

    HTTP.logger.exception('unhandled_exception', error);

    return Response.json(
      { ok: false, error: { code: 'internal_error', message: 'Unexpected server error.' } },
      { status: 500 },
    );
  }
}
