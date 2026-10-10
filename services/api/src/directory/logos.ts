import { createHash } from 'node:crypto';
import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Injectable, Optional, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { writeAudit } from '../audit/audit';
import { AuthGuard } from '../auth/auth.guard';
import { ApiError } from '../common/api-error';
import { Database } from '../db/database';
import { RequireRoles, StaffGuard } from '../staff/staff';
import { httpsFetchFrom, isBlockedAddress, ProbeDeps, systemResolve } from '../stations/stream-probe';
import { DirectoryService } from './directory';
import { logoVersion } from './logo-version';

/** Tests only: stands in for DNS and HTTPS when reading a station's Radio Browser favicon. */
export const LOGO_FETCH = Symbol('LOGO_FETCH');

/** Largest logo we store or pass on (the console shrinks uploads to 256 px, which fits easily). */
export const LOGO_MAX_BYTES = 64 * 1024;
const FETCH_TIMEOUT_MS = 5000;
const REDIRECTS = 3;
/** Favicons read from station sites, kept in memory: found ones a day, missing ones an hour. */
const FAVICON_TTL_MS = 24 * 60 * 60_000;
const FAVICON_MISS_MS = 60 * 60_000;
const FAVICON_CACHE_MAX = 500;
/** At most this many favicon reads at once; more wait their turn, so a map full of pins cannot flood the network. */
const FAVICON_CONCURRENCY = 4;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BRAND_KEY = 'brand:station-default';

export type LogoType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' | 'image/x-icon';
export interface LogoImage {
  contentType: LogoType;
  data: Buffer;
}

const invalid = (field: string, reason: string, extra: Record<string, unknown> = {}) => new ApiError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', { field, reason, ...extra });

/** The image type from the file's first bytes (never from a header or a name). SVG is never accepted: it can carry script. */
export function sniffImage(b: Buffer): LogoType | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString('latin1'))) return 'image/gif';
  if (b.length >= 6 && b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0 && b[4] > 0) return 'image/x-icon';
  return null;
}

/** Body of an upload: `{ contentType, data }`, data in base64, a PNG, JPEG or WebP of at most 64 KiB matching its type. */
export function parseLogoUpload(body: unknown): { contentType: 'image/png' | 'image/jpeg' | 'image/webp'; data: Buffer } {
  const b = typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  if (!b) throw invalid('body', 'must_be_object');
  for (const k of Object.keys(b)) if (k !== 'contentType' && k !== 'data') throw invalid(k, 'unknown_field');
  const { contentType, data } = b;
  if (contentType !== 'image/png' && contentType !== 'image/jpeg' && contentType !== 'image/webp') throw invalid('contentType', 'value_not_allowed', { allowed: ['image/png', 'image/jpeg', 'image/webp'] });
  if (typeof data !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(data) || data.length % 4 !== 0) throw invalid('data', 'must_be_base64');
  const bytes = Buffer.from(data, 'base64');
  if (bytes.length === 0 || bytes.length > LOGO_MAX_BYTES) throw invalid('data', 'too_large', { maxBytes: LOGO_MAX_BYTES });
  if (sniffImage(bytes) !== contentType) throw invalid('data', 'not_matching_type');
  return { contentType, data: bytes };
}

/**
 * Station logos for the map (Tar 2026-10-10): the one staff uploaded, else the station's Radio Browser favicon read
 * through our server (so viewers' addresses never reach station sites, and the web page loads images only from its
 * own address), else nothing, and the apps show TuneDeck's own logo, which admins can replace.
 * Favicons are read like stream checks: public addresses only, pinned connection, few redirects, small and bounded.
 */
@Injectable()
export class LogoService {
  private readonly favicons = new Map<string, { at: number; image: LogoImage | null }>();
  private readonly faviconInFlight = new Map<string, Promise<LogoImage | null>>();
  private running = 0;
  private readonly waiting: (() => void)[] = [];
  private readonly net: ProbeDeps;

  constructor(
    private readonly db: Database,
    private readonly directory: DirectoryService,
    @Optional() @Inject(LOGO_FETCH) net?: ProbeDeps,
  ) {
    this.net = net ?? { resolve: systemResolve, fetchFrom: (address, url, signal) => httpsFetchFrom(address, url, signal, LOGO_MAX_BYTES + 1) };
  }

  /** The logo to show for a station, or null when it has none (blocked stations have none). */
  async stationLogo(id: string): Promise<LogoImage | null> {
    const stored = await this.stored(`station:${id}`);
    if (stored) return stored;
    const station = await this.directory.station(id);
    if (!station?.logoUrl) return null;
    const url = station.logoUrl;
    const hit = this.favicons.get(url);
    if (hit && Date.now() - hit.at < (hit.image ? FAVICON_TTL_MS : FAVICON_MISS_MS)) return hit.image;
    let running = this.faviconInFlight.get(url);
    if (!running) {
      running = this.limited(() => readFavicon(url, this.net)).then((image) => {
        if (this.favicons.size >= FAVICON_CACHE_MAX) this.favicons.delete(this.favicons.keys().next().value!);
        this.favicons.set(url, { at: Date.now(), image });
        return image;
      });
      running.finally(() => this.faviconInFlight.delete(url)).catch(() => undefined);
      this.faviconInFlight.set(url, running);
    }
    return running;
  }

  /** Whether admins replaced TuneDeck's logo, and its version. */
  async brandStatus(): Promise<{ custom: boolean; version?: string; updatedAt?: string }> {
    const [row] = await this.db.query<{ sha256: string; updated_at: Date }>('SELECT sha256, updated_at FROM logo_images WHERE key = $1', [BRAND_KEY]);
    return row ? { custom: true, version: logoVersion(`staff:${row.sha256}`), updatedAt: row.updated_at.toISOString() } : { custom: false };
  }

  brandLogo(): Promise<LogoImage | null> {
    return this.stored(BRAND_KEY);
  }

  private async stored(key: string): Promise<LogoImage | null> {
    const [row] = await this.db.query<{ content_type: LogoType; data: Buffer }>('SELECT content_type, data FROM logo_images WHERE key = $1', [key]);
    return row ? { contentType: row.content_type, data: row.data } : null;
  }

  private async limited<T>(work: () => Promise<T>): Promise<T> {
    if (this.running >= FAVICON_CONCURRENCY) await new Promise<void>((r) => this.waiting.push(r));
    this.running++;
    try {
      return await work();
    } finally {
      this.running--;
      this.waiting.shift()?.();
    }
  }

  /** Stores a logo (replacing any) and audits it with its size and hash, never the image. */
  async set(actor: { userId: string; requestId: string }, target: { kind: 'station'; id: string } | { kind: 'brand' }, image: { contentType: string; data: Buffer }): Promise<{ version: string }> {
    const key = target.kind === 'station' ? `station:${target.id}` : BRAND_KEY;
    const sha256 = createHash('sha256').update(image.data).digest('hex');
    await this.db.transaction(async (query) => {
      const [before] = await query<{ sha256: string }>('SELECT sha256 FROM logo_images WHERE key = $1', [key]);
      await query(
        `INSERT INTO logo_images (key, content_type, data, sha256, updated_by) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (key) DO UPDATE SET content_type = EXCLUDED.content_type, data = EXCLUDED.data, sha256 = EXCLUDED.sha256, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [key, image.contentType, image.data, sha256, actor.userId],
      );
      await writeAudit(query, {
        actor: `user:${actor.userId}`,
        action: target.kind === 'station' ? 'directory.logo.set' : 'brand.logo.set',
        targetType: target.kind === 'station' ? 'directory_station' : 'brand',
        targetId: target.kind === 'station' ? target.id : 'station-default',
        changes: { contentType: image.contentType, bytes: image.data.length, sha256, ...(before ? { before: { sha256: before.sha256 } } : {}) },
        requestId: actor.requestId,
      });
    });
    return { version: logoVersion(`staff:${sha256}`) };
  }

  async remove(actor: { userId: string; requestId: string }, target: { kind: 'station'; id: string } | { kind: 'brand' }): Promise<void> {
    const key = target.kind === 'station' ? `station:${target.id}` : BRAND_KEY;
    await this.db.transaction(async (query) => {
      const [row] = await query<{ sha256: string }>('DELETE FROM logo_images WHERE key = $1 RETURNING sha256', [key]);
      if (!row) throw new ApiError(HttpStatus.NOT_FOUND, 'NOT_FOUND');
      await writeAudit(query, {
        actor: `user:${actor.userId}`,
        action: target.kind === 'station' ? 'directory.logo.remove' : 'brand.logo.remove',
        targetType: target.kind === 'station' ? 'directory_station' : 'brand',
        targetId: target.kind === 'station' ? target.id : 'station-default',
        changes: { before: { sha256: row.sha256 } },
        requestId: actor.requestId,
      });
    });
  }
}


/** One favicon: https on 443 to a public address, at most 3 redirects, 5 s, 64 KiB, a real image by its first bytes. */
export async function readFavicon(raw: string, net: ProbeDeps): Promise<LogoImage | null> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  try {
    for (let hop = 0; hop <= REDIRECTS; hop++) {
      if (url.protocol !== 'https:' || (url.port && url.port !== '443') || url.username || url.password || /^[\d.]+$|^\[/.test(url.hostname)) return null;
      const addresses = await Promise.race([
        net.resolve(url.hostname),
        new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
      ]);
      if (addresses.length === 0 || addresses.some(isBlockedAddress)) return null;
      const res = await net.fetchFrom(addresses[0], url, signal);
      if (res.status >= 300 && res.status < 400 && res.headers.location) {
        url = new URL(String(res.headers.location), url);
        continue;
      }
      if (res.status !== 200 || res.body.length === 0 || res.body.length > LOGO_MAX_BYTES) return null;
      const contentType = sniffImage(res.body);
      return contentType ? { contentType, data: Buffer.from(res.body) } : null;
    }
    return null;
  } catch {
    return null;
  }
}

function sendImage(res: Response, image: LogoImage, versioned: boolean): void {
  res.setHeader('Content-Type', image.contentType);
  res.setHeader('Cache-Control', versioned ? 'public, max-age=31536000, immutable' : 'public, max-age=3600');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.status(200).end(image.data);
}

function onlyVersion(q: Record<string, unknown>): boolean {
  for (const k of Object.keys(q)) if (k !== 'v') throw invalid(k, 'unknown_field');
  if (q.v !== undefined && (typeof q.v !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(q.v))) throw invalid('v', 'invalid');
  return q.v !== undefined;
}

function stationId(raw: string): string {
  const id = raw.toLowerCase();
  if (!UUID.test(id)) throw invalid('id', 'must_be_uuid');
  return id;
}

function emptyBody(body: unknown): void {
  const b = typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  for (const k of Object.keys(b)) throw invalid(k, 'unknown_field');
}

/** Public logo images (no sign-in), counted in their own generous per-address bucket. 404 NOT_FOUND when there is none. */
@Controller()
export class LogoController {
  constructor(private readonly logos: LogoService) {}

  @Get('v1/directory/radio/stations/:id/logo')
  async station(@Param('id') id: string, @Req() req: Request, @Res() res: Response) {
    const versioned = onlyVersion(req.query as Record<string, unknown>);
    const image = await this.logos.stationLogo(stationId(id));
    if (!image) throw new ApiError(HttpStatus.NOT_FOUND, 'NOT_FOUND');
    sendImage(res, image, versioned);
  }

  @Get('v1/brand/station-logo')
  async brand(@Req() req: Request, @Res() res: Response) {
    onlyVersion(req.query as Record<string, unknown>);
    const image = await this.logos.brandLogo();
    if (!image) throw new ApiError(HttpStatus.NOT_FOUND, 'NOT_FOUND');
    // TuneDeck's logo can change at any time and has no version in a station list, so it is kept only briefly.
    sendImage(res, image, false);
  }
}

/** Staff replace a community station's logo (Tar 2026-10-10). */
@Controller('v1/admin/directory/stations')
@UseGuards(AuthGuard, StaffGuard)
@RequireRoles('catalog_editor', 'admin')
export class AdminStationLogoController {
  constructor(private readonly logos: LogoService) {}

  @Post(':id/logo')
  @HttpCode(HttpStatus.OK)
  async set(@Req() req: Request, @Param('id') id: string, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const station = stationId(id);
    res.setHeader('Cache-Control', 'no-store');
    return { stationId: station, ...(await this.logos.set({ userId: req.actor!.userId, requestId: req.requestId }, { kind: 'station', id: station }, parseLogoUpload(body))) };
  }

  @Post(':id/logo/remove')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    const station = stationId(id);
    emptyBody(body);
    await this.logos.remove({ userId: req.actor!.userId, requestId: req.requestId }, { kind: 'station', id: station });
  }
}

/** Catalog editors and admins replace TuneDeck's own logo, shown for stations without one (Tar 2026-10-10). */
@Controller('v1/admin/brand/station-logo')
@UseGuards(AuthGuard, StaffGuard)
@RequireRoles('catalog_editor', 'admin')
export class AdminBrandLogoController {
  constructor(private readonly logos: LogoService) {}

  @Get()
  async status(@Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    return this.logos.brandStatus();
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  async set(@Req() req: Request, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    return this.logos.set({ userId: req.actor!.userId, requestId: req.requestId }, { kind: 'brand' }, parseLogoUpload(body));
  }

  @Post('remove')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Req() req: Request, @Body() body: unknown) {
    emptyBody(body);
    await this.logos.remove({ userId: req.actor!.userId, requestId: req.requestId }, { kind: 'brand' });
  }
}
