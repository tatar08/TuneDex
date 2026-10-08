import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { boundedFetch, ResponseTooLargeError } from '../src/common/bounded-fetch';

describe('boundedFetch', () => {
  let server: Server;
  let base: string;
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/redirect') return res.writeHead(302, { location: 'http://127.0.0.1:1/' }).end();
      if (req.url === '/big-declared') return res.writeHead(200, { 'content-length': '5000' }).end('x'.repeat(5000));
      if (req.url === '/big-streamed') {
        res.writeHead(200);
        for (let i = 0; i < 10; i++) res.write('y'.repeat(1000));
        return res.end();
      }
      res.writeHead(200).end('ok');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const get = (path: string) => boundedFetch(`${base}${path}`, { signal: AbortSignal.timeout(2000) }, 2048);

  it('returns a small answer', async () => {
    const res = await get('/');
    expect([res.status, await res.text()]).toEqual([200, 'ok']);
  });
  it('never follows a redirect', async () => {
    await expect(get('/redirect')).rejects.toThrow();
  });
  it('refuses a body past the cap, declared or streamed', async () => {
    await expect(get('/big-declared')).rejects.toBeInstanceOf(ResponseTooLargeError);
    await expect(get('/big-streamed')).rejects.toBeInstanceOf(ResponseTooLargeError);
  });
});
