import type { Env } from './Env';
import { RelayManagementPage } from './RelayManagementPage';

/** The public website uses the MCP Worker's single copy of onboarding assets. */
export class PublicWebsite {
  private static readonly paths = new Set(['/', '/start', '/start.css', '/start.js']);

  constructor(private readonly mcp: Env['MCP_WORKER']) {}

  static handles(request: Request): boolean {
    const url = new URL(request.url);

    return request.method === 'GET' && url.origin === RelayManagementPage.origin &&
      PublicWebsite.paths.has(url.pathname);
  }

  async page(request: Request): Promise<Response> {
    // Send only the public URL; never forward account credentials or cookies.
    const response = await this.mcp.fetch(new Request(request.url, { redirect: 'manual' }));

    return new Response(response.body, response);
  }
}
