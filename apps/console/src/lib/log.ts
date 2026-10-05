export type LogWriter = (line: string) => void;

export interface BffLogFields {
  eventCode: string;
  requestId: string;
  /** W3C trace id shared with the API lines of the same request. */
  traceId: string;
  method: string;
  route: string;
  status: number;
  durationMs: number;
  upstreamStatus?: number;
}

/** One JSON line per BFF request; only these fields, so tokens, cookies and bodies never reach the log. */
export function createLogger(write: LogWriter = (l) => process.stdout.write(l), where: { environment: string; build: string } = { environment: 'unknown', build: 'unknown' }) {
  return (severity: 'INFO' | 'WARN' | 'ERROR', fields: BffLogFields) =>
    write(JSON.stringify({ timestamp: new Date().toISOString(), severity, service: 'console', environment: where.environment, build: where.build, ...fields }) + '\n');
}

const TRACEPARENT = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(-.*)?$/;

/** The trace id of a valid W3C `traceparent` header (same rules as the API), or null. */
export function traceIdFrom(header: string | null | undefined): string | null {
  const m = header ? TRACEPARENT.exec(header.trim()) : null;
  if (!m) return null;
  const [, version, traceId, parentId, , rest] = m;
  if (version === 'ff' || (version === '00' && rest !== undefined)) return null;
  if (/^0+$/.test(traceId) || /^0+$/.test(parentId)) return null;
  return traceId;
}
