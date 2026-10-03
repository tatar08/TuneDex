import { ChildProcess, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { ApiProcess, startApi } from '../test/api-process';
import { CLIENT_ID, CLIENT_SECRET, MockIdp, startMockIdp } from '../test/mock-idp';

/** Real Next.js build + real services/api + PostgreSQL, with the test-only IdP. */
export interface Stack {
  idp: MockIdp;
  api: ApiProcess;
  base: string;
  stop: () => Promise<void>;
}

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });

export async function startStack(): Promise<Stack> {
  const idp = await startMockIdp();
  const api = await startApi(idp.issuer);
  const port = await freePort();
  const base = `http://localhost:${port}`;
  const web: ChildProcess = spawn(join(__dirname, '../node_modules/.bin/next'), ['start', '-p', String(port)], {
    cwd: join(__dirname, '..'),
    stdio: 'ignore',
    env: {
      ...process.env,
      NEXT_TELEMETRY_DISABLED: '1',
      CONSOLE_BASE_URL: base,
      API_BASE_URL: api.url,
      OIDC_ISSUER: idp.issuer,
      OIDC_CLIENT_ID: CLIENT_ID,
      OIDC_CLIENT_SECRET: CLIENT_SECRET,
      SESSION_SECRET: 'e2e-'.repeat(10),
    },
  });
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(`${base}/login`);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  return {
    idp,
    api,
    base,
    stop: async () => {
      web.kill('SIGTERM');
      await api.stop();
      await idp.close();
    },
  };
}
