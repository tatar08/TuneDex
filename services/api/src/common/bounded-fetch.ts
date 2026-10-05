/**
 * Outbound GET/POST for third-party services: never follows a redirect (a compromised or misconfigured service
 * cannot bounce the call to an internal address), and reads at most `maxBytes` of the answer, refusing as soon
 * as the declared or streamed size passes it.
 */
export async function boundedFetch(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string; signal: AbortSignal },
  maxBytes: number,
): Promise<{ status: number; text(): Promise<string> }> {
  const res = await fetch(url, { ...init, redirect: 'error' });
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    throw new ResponseTooLargeError();
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (res.body) {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ResponseTooLargeError();
      }
      chunks.push(value);
    }
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return { status: res.status, text: async () => text };
}

export class ResponseTooLargeError extends Error {
  override name = 'ResponseTooLargeError';
  constructor() {
    super('response too large');
  }
}
