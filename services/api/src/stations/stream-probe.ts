import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { BlockList, isIP } from 'node:net';

/**
 * One bounded check of a published stream (Doc 17 "Catalog checker and SSRF boundary"):
 * every DNS answer and redirect target must be a public address, the connection goes to the
 * address that was checked (no second lookup to rebind), at most 3 redirects, 10 s, 64 KiB.
 * Only headers and the first bytes are read; nothing is recorded.
 */
export type ProbeReason =
  | 'ok'
  | 'invalid_url'
  | 'dns_failed'
  | 'blocked_address'
  | 'timeout'
  | 'connect_failed'
  | 'http_status'
  | 'too_many_redirects'
  | 'not_audio';

export interface ProbeResult {
  ok: boolean;
  reason: ProbeReason;
  httpStatus: number | null;
  latencyMs: number;
  contentType: string | null;
}

export interface FetchedHead {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  /** Up to the first MAX_BODY bytes. */
  body: Buffer;
}

export interface ProbeDeps {
  resolve: (host: string) => Promise<string[]>;
  /** Fetches `url` from exactly `address`, sending the URL's host name for TLS and Host. */
  fetchFrom: (address: string, url: URL, signal: AbortSignal) => Promise<FetchedHead>;
  now?: () => number;
  /** Tests may shorten the timeout; it can never exceed LIMITS.timeoutMs. */
  timeoutMs?: number;
}

export const LIMITS = { redirects: 3, timeoutMs: 10_000, bodyBytes: 64 * 1024 };
const SNIFF_BYTES = Math.min(1024, LIMITS.bodyBytes);

const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  blocked.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
] as const)
  blocked.addSubnet(net, prefix, 'ipv6');

/** True for loopback, private, link-local, metadata, CGNAT, documentation, multicast and reserved addresses. */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return blocked.check(address, 'ipv4');
  if (family === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    if (mapped) return blocked.check(mapped[1], 'ipv4');
    return blocked.check(address, 'ipv6');
  }
  return true;
}

const AUDIO_TYPES = /^(audio\/|application\/(ogg|vnd\.apple\.mpegurl|x-mpegurl|octet-stream)\b)/i;

function looksLikeAudio(head: FetchedHead): boolean {
  const type = String(head.headers['content-type'] ?? '');
  if (AUDIO_TYPES.test(type)) return true;
  if (head.headers['icy-name'] !== undefined || head.headers['icy-br'] !== undefined) return true;
  return head.body.subarray(0, 7).toString('latin1') === '#EXTM3U';
}

/** Only public HTTPS on 443 with a host name, as station URLs are validated on save. */
function acceptable(url: URL): boolean {
  return url.protocol === 'https:' && (!url.port || url.port === '443') && !url.username && !url.password && !isIP(url.hostname.replace(/^\[|\]$/g, ''));
}

export async function probeStream(raw: string, deps: ProbeDeps): Promise<ProbeResult> {
  const now = deps.now ?? Date.now;
  const started = now();
  const done = (reason: ProbeReason, httpStatus: number | null = null, contentType: string | null = null): ProbeResult => ({
    ok: reason === 'ok',
    reason,
    httpStatus,
    latencyMs: Math.max(0, Math.round(now() - started)),
    contentType: contentType ? contentType.slice(0, 100) : null,
  });
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return done('invalid_url');
  }
  const signal = AbortSignal.timeout(Math.min(deps.timeoutMs ?? LIMITS.timeoutMs, LIMITS.timeoutMs));
  try {
    for (let hop = 0; hop <= LIMITS.redirects; hop++) {
      if (!acceptable(url)) return done(hop === 0 ? 'invalid_url' : 'blocked_address');
      let addresses: string[];
      try {
        addresses = await deps.resolve(url.hostname);
      } catch {
        return done(signal.aborted ? 'timeout' : 'dns_failed');
      }
      if (addresses.length === 0) return done('dns_failed');
      if (addresses.some(isBlockedAddress)) return done('blocked_address');
      let head: FetchedHead;
      try {
        head = await deps.fetchFrom(addresses[0], url, signal);
      } catch {
        return done(signal.aborted ? 'timeout' : 'connect_failed');
      }
      const type = typeof head.headers['content-type'] === 'string' ? (head.headers['content-type'] as string) : null;
      if (head.status >= 300 && head.status < 400 && head.headers.location) {
        try {
          url = new URL(String(head.headers.location), url);
        } catch {
          return done('http_status', head.status);
        }
        continue;
      }
      if (head.status < 200 || head.status >= 300) return done('http_status', head.status, type);
      return looksLikeAudio(head) ? done('ok', head.status, type) : done('not_audio', head.status, type);
    }
    return done('too_many_redirects');
  } catch {
    return done(signal.aborted ? 'timeout' : 'connect_failed');
  }
}

/** Real DNS: every address for the name, so one private answer blocks the whole check. */
export const systemResolve = async (host: string) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

/**
 * Real HTTPS GET pinned to `address` with normal certificate checks against the host name.
 * Hangs up after the first bytes (enough to spot a playlist), never past LIMITS.bodyBytes.
 */
export function httpsFetchFrom(address: string, url: URL, signal: AbortSignal): Promise<FetchedHead> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: address,
        port: 443,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        servername: url.hostname,
        headers: { host: url.host, 'user-agent': 'TuneDeck-StationCheck/1', 'icy-metadata': '0', accept: '*/*' },
        // Never look the name up again: connect to the address that passed the check.
        lookup: (_h, _o, cb) => cb(null, address, isIP(address)),
        signal,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        const finish = () => {
          res.destroy();
          req.destroy();
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).subarray(0, LIMITS.bodyBytes) });
        };
        if ((res.statusCode ?? 0) >= 300) return finish();
        res.on('data', (c: Buffer) => {
          chunks.push(c);
          size += c.length;
          if (size >= SNIFF_BYTES) finish();
        });
        res.on('end', finish);
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end();
  });
}
