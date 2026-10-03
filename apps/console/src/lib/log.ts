export type LogWriter = (line: string) => void;

export interface BffLogFields {
  eventCode: string;
  requestId: string;
  method: string;
  route: string;
  status: number;
  durationMs: number;
  upstreamStatus?: number;
}

/** One JSON line per BFF request; only these fields, so tokens, cookies and bodies never reach the log. */
export function createLogger(write: LogWriter = (l) => process.stdout.write(l)) {
  return (severity: 'INFO' | 'WARN' | 'ERROR', fields: BffLogFields) =>
    write(JSON.stringify({ timestamp: new Date().toISOString(), severity, service: 'console', ...fields }) + '\n');
}
