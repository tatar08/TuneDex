import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Injectable, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { writeAudit } from '../audit/audit';
import { AuthGuard } from '../auth/auth.guard';
import { ApiError } from '../common/api-error';
import { StructuredLogger } from '../common/logger';
import { APP_CONFIG, AppConfig } from '../config';
import { Database } from '../db/database';
import { RequireRoles, StaffGuard } from '../staff/staff';
import { parseStreamUrl } from '../stations/stations.schema';

/** Tests only: stands in for the network when asking Radio Browser. */
export const DIRECTORY_FETCH = Symbol('DIRECTORY_FETCH');
export type DirectoryFetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ status: number; text(): Promise<string> }>;

/** One community station as the apps get it. Never part of our curated catalog, and never published by us. */
export interface DirectoryStation {
  /** Radio Browser's stationuuid. */
  id: string;
  name: string;
  country: string | null;
  language: string | null;
  genres: string[];
  streamUrl: string;
  codec: 'mp3' | 'aac' | 'hls';
  bitrateKbps: number | null;
  logoUrl: string | null;
  homepageUrl: string | null;
}

export interface DirectoryQuery {
  q: string | null;
  country: string | null;
  language: string | null;
  tag: string | null;
  limit: number;
  offset: number;
}

export interface DirectoryBlock {
  id: string;
  kind: 'station' | 'host';
  value: string;
  reason: string;
  createdBy: string | null;
  createdAt: string;
}

export const DIRECTORY_ATTRIBUTION = 'Radio Browser (www.radio-browser.info), community data';
const LIMIT = { min: 1, max: 50, default: 30 };
const OFFSET_MAX = 1000;
const CACHE_TTL_MS = 10 * 60_000;
/** When Radio Browser is down, a cached answer up to this old is served rather than an error. */
const CACHE_STALE_MS = 60 * 60_000;
const CACHE_MAX = 500;
const UPSTREAM_TIMEOUT_MS = 5000;
export const UPSTREAM_MAX_BYTES = 2 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HOST = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const UNSAFE = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g;

const invalid = (field: string, reason: string, extra: Record<string, unknown> = {}) =>
  new ApiError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', { field, reason, ...extra });

function one(q: Record<string, unknown>, key: string): string | null {
  const v = q[key];
  if (v === undefined || v === '') return null;
  if (typeof v !== 'string') throw invalid(key, 'must_be_string');
  return v;
}

/** `q` (name), `country`, `language`, `tag`, `limit`, `offset`; anything else is 400. */
export function parseDirectoryQuery(q: Record<string, unknown>): DirectoryQuery {
  for (const k of Object.keys(q)) if (!['q', 'country', 'language', 'tag', 'limit', 'offset'].includes(k)) throw invalid(k, 'unknown_field');
  const name = one(q, 'q')?.normalize('NFC').replace(UNSAFE, '').trim() ?? null;
  if (name !== null && (name.length === 0 || name.length > 80)) throw invalid('q', 'out_of_range', { max: 80 });
  const country = one(q, 'country');
  if (country !== null && !/^[A-Za-z]{2}$/.test(country)) throw invalid('country', 'iso_3166_alpha2');
  const language = one(q, 'language');
  if (language !== null && !/^[\p{L} -]{2,40}$/u.test(language)) throw invalid('language', 'out_of_range');
  const tag = one(q, 'tag');
  if (tag !== null && !/^[\p{L}\p{N} &+-]{1,30}$/u.test(tag)) throw invalid('tag', 'out_of_range');
  const limitRaw = one(q, 'limit');
  const limit = limitRaw === null ? LIMIT.default : /^\d{1,3}$/.test(limitRaw) ? Number(limitRaw) : NaN;
  if (!(limit >= LIMIT.min && limit <= LIMIT.max)) throw invalid('limit', 'out_of_range', { max: LIMIT.max });
  const offsetRaw = one(q, 'offset');
  const offset = offsetRaw === null ? 0 : /^\d{1,4}$/.test(offsetRaw) ? Number(offsetRaw) : NaN;
  if (!(offset >= 0 && offset <= OFFSET_MAX)) throw invalid('offset', 'out_of_range', { max: OFFSET_MAX });
  return { q: name, country: country?.toUpperCase() ?? null, language: language?.toLowerCase() ?? null, tag: tag?.toLowerCase() ?? null, limit, offset };
}

function httpsUrl(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 2048) return null;
  try {
    const u = new URL(v.trim());
    return u.protocol === 'https:' && !u.username && !u.password ? u.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Turns one Radio Browser record into a station the apps can play, or null. Only plain public HTTPS streams
 * (the same rules as our own catalog) in a codec the players support, with a name, get through.
 */
export function toDirectoryStation(raw: unknown): DirectoryStation | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.stationuuid === 'string' ? r.stationuuid.toLowerCase() : '';
  if (!UUID.test(id)) return null;
  const name = typeof r.name === 'string' ? r.name.normalize('NFC').replace(UNSAFE, '').replace(/\s+/g, ' ').trim().slice(0, 80) : '';
  if (!name) return null;
  let streamUrl: string;
  try {
    streamUrl = parseStreamUrl(typeof r.url_resolved === 'string' && r.url_resolved ? r.url_resolved.trim() : typeof r.url === 'string' ? r.url.trim() : '');
  } catch {
    return null;
  }
  const codecRaw = typeof r.codec === 'string' ? r.codec.toUpperCase() : '';
  const codec = r.hls === 1 ? 'hls' : codecRaw === 'MP3' ? 'mp3' : codecRaw === 'AAC' || codecRaw === 'AAC+' ? 'aac' : null;
  if (!codec) return null;
  const country = typeof r.countrycode === 'string' && /^[A-Z]{2}$/.test(r.countrycode) ? r.countrycode : null;
  const language = typeof r.language === 'string' ? r.language.split(',')[0].trim().toLowerCase().slice(0, 40) || null : null;
  const genres =
    typeof r.tags === 'string'
      ? [...new Set(r.tags.split(',').map((t) => t.trim().toLowerCase()).filter((t) => /^[\p{L}\p{N}][\p{L}\p{N} &+-]{0,29}$/u.test(t)))].slice(0, 5)
      : [];
  const bitrate = typeof r.bitrate === 'number' && Number.isInteger(r.bitrate) && r.bitrate > 0 && r.bitrate <= 1000 ? r.bitrate : null;
  return { id, name, country, language, genres, streamUrl, codec, bitrateKbps: bitrate, logoUrl: httpsUrl(r.favicon), homepageUrl: httpsUrl(r.homepage) };
}

/** Lower case, without a trailing dot, so `radio.example.com.` cannot slip past a block on `example.com`. */
const hostOf = (url: string) => new URL(url).hostname.toLowerCase().replace(/\.+$/, '');

/**
 * Search of the Radio Browser community directory through our server (decided by Tar 2026-10-05), so the apps
 * never call it directly: results are cached, filtered to streams the players can use, and stations staff have
 * blocked never appear. Search text is never logged. Off unless RADIO_BROWSER_BASE_URL is set.
 */
@Injectable()
export class DirectoryService {
  private readonly cache = new Map<string, { at: number; stations: DirectoryStation[]; full: boolean }>();
  /** One upstream call per search at a time: concurrent misses for the same search share it. */
  private readonly inFlight = new Map<string, Promise<{ stations: DirectoryStation[]; full: boolean }>>();

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(DIRECTORY_FETCH) private readonly http: DirectoryFetch,
    private readonly db: Database,
    private readonly logger: StructuredLogger,
  ) {}

  async search(query: DirectoryQuery): Promise<{ stations: DirectoryStation[]; nextOffset: number | null; attribution: string }> {
    const dir = this.config.radioDirectory;
    if (!dir) throw new ApiError(HttpStatus.SERVICE_UNAVAILABLE, 'DEPENDENCY_UNAVAILABLE', { dependency: 'radio_directory', reason: 'not_configured' });
    const page = await this.upstream(dir.baseUrl, query);
    const blocks = await this.blockSets();
    const stations = page.stations.filter((s) => {
      if (blocks.stations.has(s.id)) return false;
      const host = hostOf(s.streamUrl);
      for (const b of blocks.hosts) if (host === b || host.endsWith(`.${b}`)) return false;
      return true;
    });
    return { stations, nextOffset: page.full && query.offset + query.limit <= OFFSET_MAX ? query.offset + query.limit : null, attribution: DIRECTORY_ATTRIBUTION };
  }

  private async upstream(baseUrl: string, q: DirectoryQuery): Promise<{ stations: DirectoryStation[]; full: boolean }> {
    const params = new URLSearchParams({ hidebroken: 'true', is_https: 'true', order: 'clickcount', reverse: 'true', limit: String(q.limit), offset: String(q.offset) });
    if (q.q) params.set('name', q.q);
    if (q.country) params.set('countrycode', q.country);
    if (q.language) params.set('language', q.language);
    if (q.tag) params.set('tag', q.tag);
    const key = params.toString();
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached;
    const running = this.inFlight.get(key);
    if (running) return running;
    const call = this.fetchPage(baseUrl, key, q.limit, cached).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, call);
    return call;
  }

  private async fetchPage(baseUrl: string, key: string, limit: number, cached: { at: number; stations: DirectoryStation[]; full: boolean } | undefined): Promise<{ stations: DirectoryStation[]; full: boolean }> {
    try {
      const res = await this.http(`${baseUrl}/json/stations/search?${key}`, {
        headers: { accept: 'application/json', 'user-agent': `TuneDeck-API/${this.config.build}` },
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      if (res.status !== 200) throw new Error(`status ${res.status}`);
      const body = await res.text();
      if (body.length > UPSTREAM_MAX_BYTES) throw new Error('too large');
      const raw: unknown = JSON.parse(body);
      if (!Array.isArray(raw)) throw new Error('not a list');
      const seen = new Set<string>();
      const stations = raw.map(toDirectoryStation).filter((s): s is DirectoryStation => !!s && !seen.has(s.id) && !!seen.add(s.id));
      const entry = { at: Date.now(), stations, full: raw.length >= limit };
      this.cache.delete(key);
      this.cache.set(key, entry);
      if (this.cache.size > CACHE_MAX) this.cache.delete(this.cache.keys().next().value!);
      return entry;
    } catch (err) {
      this.logger.log('WARN', { eventCode: 'RADIO_DIRECTORY_UNAVAILABLE', errorName: err instanceof Error ? err.name : 'Error' });
      if (cached && Date.now() - cached.at < CACHE_STALE_MS) return cached;
      throw new ApiError(HttpStatus.SERVICE_UNAVAILABLE, 'DEPENDENCY_UNAVAILABLE', { dependency: 'radio_directory', reason: 'unreachable' });
    }
  }

  private async blockSets(): Promise<{ stations: Set<string>; hosts: string[] }> {
    const rows = await this.db.query<{ kind: string; value: string }>('SELECT kind, value FROM directory_blocks');
    return { stations: new Set(rows.filter((r) => r.kind === 'station').map((r) => r.value)), hosts: rows.filter((r) => r.kind === 'host').map((r) => r.value) };
  }

  async blocks(): Promise<DirectoryBlock[]> {
    const rows = await this.db.query<{ id: string; kind: 'station' | 'host'; value: string; reason: string; subject: string | null; created_at: Date }>(
      `SELECT b.id::text, b.kind, b.value, b.reason, u.oidc_subject AS subject, b.created_at
         FROM directory_blocks b LEFT JOIN users u ON u.id = b.created_by ORDER BY b.created_at DESC, b.id DESC`,
    );
    return rows.map((r) => ({ id: r.id, kind: r.kind, value: r.value, reason: r.reason, createdBy: r.subject, createdAt: r.created_at.toISOString() }));
  }

  async addBlock(actor: { userId: string; requestId: string }, block: { kind: 'station' | 'host'; value: string; reason: string }): Promise<DirectoryBlock> {
    return this.db.transaction(async (query) => {
      const [row] = await query<{ id: string; created_at: Date }>(
        `INSERT INTO directory_blocks (kind, value, reason, created_by) VALUES ($1, $2, $3, $4)
         ON CONFLICT (kind, value) DO NOTHING RETURNING id::text, created_at`,
        [block.kind, block.value, block.reason, actor.userId],
      );
      if (!row) throw new ApiError(HttpStatus.CONFLICT, 'DIRECTORY_BLOCK_EXISTS');
      await writeAudit(query, {
        actor: `user:${actor.userId}`,
        action: 'directory.block.add',
        targetType: 'directory_block',
        targetId: row.id,
        reason: block.reason,
        changes: { kind: block.kind, value: block.value },
        requestId: actor.requestId,
      });
      const [subject] = await query<{ oidc_subject: string }>('SELECT oidc_subject FROM users WHERE id = $1', [actor.userId]);
      return { id: row.id, ...block, createdBy: subject?.oidc_subject ?? null, createdAt: row.created_at.toISOString() };
    });
  }

  async removeBlock(actor: { userId: string; requestId: string }, id: string, reason: string): Promise<void> {
    await this.db.transaction(async (query) => {
      const [row] = await query<{ kind: string; value: string }>('DELETE FROM directory_blocks WHERE id = $1 RETURNING kind, value', [id]);
      if (!row) throw new ApiError(HttpStatus.NOT_FOUND, 'NOT_FOUND');
      await writeAudit(query, {
        actor: `user:${actor.userId}`,
        action: 'directory.block.remove',
        targetType: 'directory_block',
        targetId: id,
        reason,
        changes: { kind: row.kind, value: row.value },
        requestId: actor.requestId,
      });
    });
  }
}

/** Body of a new block: `{ kind: 'station' | 'host', value, reason }`. */
export function parseBlock(body: unknown): { kind: 'station' | 'host'; value: string; reason: string } {
  const b = typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  if (!b) throw invalid('body', 'must_be_object');
  for (const k of Object.keys(b)) if (!['kind', 'value', 'reason'].includes(k)) throw invalid(k, 'unknown_field');
  if (b.kind !== 'station' && b.kind !== 'host') throw invalid('kind', 'value_not_allowed');
  const value = typeof b.value === 'string' ? b.value.trim().toLowerCase().replace(/\.$/, '') : '';
  if (b.kind === 'station' ? !UUID.test(value) : !HOST.test(value)) throw invalid('value', b.kind === 'station' ? 'must_be_uuid' : 'must_be_host');
  return { kind: b.kind, value, reason: parseBlockReason(b.reason) };
}

export function parseBlockReason(v: unknown): string {
  const reason = typeof v === 'string' ? v.normalize('NFC').trim() : '';
  if (reason.length < 10 || reason.length > 500 || /[\u0000-\u001f\u007f-\u009f]/.test(reason)) throw invalid('reason', 'length');
  return reason;
}

/** Public, sign-in-free search of the community directory (rate limited per client address like the catalog). */
@Controller('v1/directory/radio')
export class DirectoryController {
  constructor(private readonly directory: DirectoryService) {}

  @Get()
  async search(@Query() q: Record<string, unknown>, @Res({ passthrough: true }) res: Response) {
    const result = await this.directory.search(parseDirectoryQuery(q));
    res.setHeader('Cache-Control', 'public, max-age=300');
    return result;
  }
}

/** Staff take community stations out of the search, e.g. on a rights holder's complaint (Doc 10). */
@Controller('v1/admin/directory/blocks')
@UseGuards(AuthGuard, StaffGuard)
@RequireRoles('catalog_editor', 'admin')
export class AdminDirectoryController {
  constructor(private readonly directory: DirectoryService) {}

  @Get()
  async list(@Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    return { blocks: await this.directory.blocks() };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async add(@Req() req: Request, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    return this.directory.addBlock({ userId: req.actor!.userId, requestId: req.requestId }, parseBlock(body));
  }

  /** Lifting a block also needs a reason: `{ reason }`. */
  @Post(':id/remove')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    if (!/^[1-9]\d{0,17}$/.test(id)) throw invalid('id', 'must_be_number');
    const b = typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
    for (const k of Object.keys(b)) if (k !== 'reason') throw invalid(k, 'unknown_field');
    await this.directory.removeBlock({ userId: req.actor!.userId, requestId: req.requestId }, id, parseBlockReason(b.reason));
  }
}
