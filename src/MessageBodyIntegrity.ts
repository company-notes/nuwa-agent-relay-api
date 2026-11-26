export class MessageBodyIntegrity {
  static async describe(body: string) {
    const bytes = new TextEncoder().encode(body);
    const digest = await crypto.subtle.digest('SHA-256', bytes);

    return {
      bodyLength: Array.from(body).length,
      bodyByteLength: bytes.byteLength,
      bodySHA256: Array.from(new Uint8Array(digest),
        (byte) => byte.toString(16).padStart(2, '0')).join(''),
    };
  }
}
