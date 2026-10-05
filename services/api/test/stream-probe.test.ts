import { FetchedHead, isBlockedAddress, LIMITS, probeStream, ProbeDeps, httpsFetchFrom, systemResolve } from '../src/stations/stream-probe';

const PUBLIC = '93.184.216.34';
const audio = (extra: Partial<FetchedHead> = {}): FetchedHead => ({ status: 200, headers: { 'content-type': 'audio/mpeg' }, body: Buffer.from('ID3'), ...extra });

/** Fake DNS + HTTPS: `names` maps host → addresses, `pages` maps full URL → response. Records every fetch. */
function fake(names: Record<string, string[]>, pages: Record<string, FetchedHead>) {
  const fetched: { address: string; url: string }[] = [];
  const deps: ProbeDeps = {
    resolve: async (host) => {
      if (!(host in names)) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
      return names[host];
    },
    fetchFrom: async (address, url) => {
      fetched.push({ address, url: url.toString() });
      const page = pages[url.toString()];
      if (!page) throw new Error('ECONNREFUSED');
      return page;
    },
  };
  return { deps, fetched };
}

describe('isBlockedAddress', () => {
  it.each([
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1',
    '0.0.0.0', '224.0.0.1', '255.255.255.255', '192.0.2.10', '198.18.0.1',
    '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:169.254.169.254',
    '64:ff9b::a9fe:a9fe', '2002:7f00:1::1', 'not-an-ip', '::7f00:1', '::ffff:7f00:1', '::ffff:0:7f00:1',
  ])('blocks %s', (a) => expect(isBlockedAddress(a)).toBe(true));

  it.each(['93.184.216.34', '1.1.1.1', '172.32.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8'])('allows public %s', (a) =>
    expect(isBlockedAddress(a)).toBe(false),
  );
});

describe('probeStream', () => {
  it('passes a public audio stream and connects to the address it checked', async () => {
    const f = fake({ 'radio.example.com': [PUBLIC] }, { 'https://radio.example.com/live': audio() });
    const r = await probeStream('https://radio.example.com/live', f.deps);
    expect(r).toMatchObject({ ok: true, reason: 'ok', httpStatus: 200, contentType: 'audio/mpeg' });
    expect(f.fetched).toEqual([{ address: PUBLIC, url: 'https://radio.example.com/live' }]);
  });

  it.each([
    ['an HLS playlist by type', { headers: { 'content-type': 'application/vnd.apple.mpegurl' } }],
    ['an HLS playlist by its first line', { headers: { 'content-type': 'text/plain' }, body: Buffer.from('#EXTM3U\n#EXT-X-VERSION:3') }],
    ['an Icecast stream', { headers: { 'content-type': 'text/html', 'icy-name': 'Jazz' } }],
  ])('recognises %s', async (_n, page) => {
    const f = fake({ 'radio.example.com': [PUBLIC] }, { 'https://radio.example.com/live': audio(page as Partial<FetchedHead>) });
    expect((await probeStream('https://radio.example.com/live', f.deps)).reason).toBe('ok');
  });

  it('fails a web page that is not audio', async () => {
    const f = fake({ 'radio.example.com': [PUBLIC] }, { 'https://radio.example.com/live': audio({ headers: { 'content-type': 'text/html' }, body: Buffer.from('<html>') }) });
    expect(await probeStream('https://radio.example.com/live', f.deps)).toMatchObject({ ok: false, reason: 'not_audio' });
  });

  it('reports the HTTP status of an error page', async () => {
    const f = fake({ 'radio.example.com': [PUBLIC] }, { 'https://radio.example.com/live': audio({ status: 404 }) });
    expect(await probeStream('https://radio.example.com/live', f.deps)).toMatchObject({ ok: false, reason: 'http_status', httpStatus: 404 });
  });

  it('never connects when any DNS answer is private (rebinding with mixed answers)', async () => {
    const f = fake({ 'evil.example.com': [PUBLIC, '127.0.0.1'] }, {});
    expect((await probeStream('https://evil.example.com/live', f.deps)).reason).toBe('blocked_address');
    expect(f.fetched).toEqual([]);
  });

  it('re-checks every redirect and stops at a private or metadata target', async () => {
    const f = fake(
      { 'radio.example.com': [PUBLIC], 'metadata.example.com': ['169.254.169.254'] },
      { 'https://radio.example.com/live': { status: 302, headers: { location: 'https://metadata.example.com/latest' }, body: Buffer.alloc(0) } },
    );
    expect((await probeStream('https://radio.example.com/live', f.deps)).reason).toBe('blocked_address');
    expect(f.fetched).toHaveLength(1);
  });

  it.each(['http://radio.example.com/live', 'https://127.0.0.1/live', 'https://radio.example.com:8443/live', 'https://u:p@radio.example.com/'])(
    'refuses to follow a redirect to %s',
    async (location) => {
      const f = fake({ 'radio.example.com': [PUBLIC] }, { 'https://radio.example.com/a': { status: 301, headers: { location }, body: Buffer.alloc(0) } });
      expect((await probeStream('https://radio.example.com/a', f.deps)).reason).toBe('blocked_address');
      expect(f.fetched).toHaveLength(1);
    },
  );

  it(`follows at most ${LIMITS.redirects} redirects`, async () => {
    const hop = (n: number): FetchedHead => ({ status: 302, headers: { location: `/r${n + 1}` }, body: Buffer.alloc(0) });
    const pages = Object.fromEntries([0, 1, 2, 3, 4].map((n) => [`https://radio.example.com/r${n}`, hop(n)]));
    const f = fake({ 'radio.example.com': [PUBLIC] }, pages);
    expect((await probeStream('https://radio.example.com/r0', f.deps)).reason).toBe('too_many_redirects');
    expect(f.fetched).toHaveLength(LIMITS.redirects + 1);

    const ok = fake({ 'radio.example.com': [PUBLIC] }, { ...pages, 'https://radio.example.com/r3': audio() });
    expect((await probeStream('https://radio.example.com/r0', ok.deps)).reason).toBe('ok');
  });

  it('reports DNS failures and refused connections', async () => {
    expect((await probeStream('https://missing.example.com/', fake({}, {}).deps)).reason).toBe('dns_failed');
    expect((await probeStream('https://radio.example.com/', fake({ 'radio.example.com': [PUBLIC] }, {}).deps)).reason).toBe('connect_failed');
    expect((await probeStream('not a url', fake({}, {}).deps)).reason).toBe('invalid_url');
  });

  it('gives up when the server stalls', async () => {
    const deps: ProbeDeps = {
      resolve: async () => [PUBLIC],
      fetchFrom: (_a, _u, signal) => new Promise((_r, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))),
      timeoutMs: 50,
    };
    expect((await probeStream('https://radio.example.com/live', deps)).reason).toBe('timeout');
  });

  it('gives up when the resolver stalls, without waiting for it', async () => {
    const deps: ProbeDeps = { resolve: () => new Promise(() => undefined), fetchFrom: async () => audio(), timeoutMs: 50 };
    const started = Date.now();
    expect((await probeStream('https://radio.example.com/live', deps)).reason).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('blocks localhost with the real resolver before any connection is made', async () => {
    const fetchFrom = jest.fn(httpsFetchFrom);
    expect((await probeStream('https://localhost/live', { resolve: systemResolve, fetchFrom })).reason).toBe('blocked_address');
    expect(fetchFrom).not.toHaveBeenCalled();
  });
});
