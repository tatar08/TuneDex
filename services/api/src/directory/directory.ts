import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Injectable, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { UNSAFE_TEXT } from '../common/text-safety';
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
  /** Only in answers to hasGeo=true (the web map), so the apps' station shape stays as it was. */
  geo?: { lat: number; lon: number };
}

export interface DirectoryQuery {
  q: string | null;
  country: string | null;
  language: string | null;
  tag: string | null;
  limit: number;
  offset: number;
  /** Only stations Radio Browser has coordinates for, each with its geo. */
  hasGeo: boolean;
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
const COUNTRY_TTL_MS = 60 * 60_000;
const UPSTREAM_TIMEOUT_MS = 5000;
export const UPSTREAM_MAX_BYTES = 2 * 1024 * 1024;
/**
 * Map regions where the explorer lists every station Radio Browser has, not only the world's most popular (Tar
 * 2026-10-09): Thailand, Japan, South Korea, the United States, and Europe (UN geoscheme, Russia included).
 */
export const FEATURED_COUNTRIES = ['TH', 'JP', 'KR', 'US'];
export const EUROPE = ['AD', 'AL', 'AT', 'BA', 'BE', 'BG', 'BY', 'CH', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FO', 'FR', 'GB', 'GG', 'GI', 'GR', 'HR', 'HU', 'IE', 'IM', 'IS', 'IT', 'JE', 'LI', 'LT', 'LU', 'LV', 'MC', 'MD', 'ME', 'MK', 'MT', 'NL', 'NO', 'PL', 'PT', 'RO', 'RS', 'RU', 'SE', 'SI', 'SK', 'SM', 'UA', 'VA'];
/** Upstream page size for whole-country lists, and the most stations one country or the world map holds. */
const BULK_PAGE = 500;
const BULK_MAX_BYTES = 8 * 1024 * 1024;
export const COUNTRY_MAX = 5000;
/** On the world map: the world's most popular stations with coordinates, then each featured region's own, capped. */
const WORLD_TOP = 500;
const WORLD_CAP: Record<string, number> = { US: 3000 };
const WORLD_CAP_FEATURED = COUNTRY_MAX;
const WORLD_CAP_EUROPE = 1000;
/** Whole lists are refreshed behind the answer once an hour, and served up to a day old while Radio Browser is down. */
const BULK_TTL_MS = 60 * 60_000;
const BULK_STALE_MS = 24 * 60 * 60_000;
/** A list that came back incomplete (one country failed) is retried after this long instead of an hour. */
const BULK_RETRY_MS = 5 * 60_000;
const BULK_CACHE_MAX = 300;
const BULK_CONCURRENCY = 4;
const ADMIN_PAGE = 100;
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

/** `q` (name), `country`, `language`, `tag`, `limit`, `offset`, `hasGeo`; anything else is 400. */
export function parseDirectoryQuery(q: Record<string, unknown>): DirectoryQuery {
  for (const k of Object.keys(q)) if (!['q', 'country', 'language', 'tag', 'limit', 'offset', 'hasGeo'].includes(k)) throw invalid(k, 'unknown_field');
  const hasGeoRaw = one(q, 'hasGeo');
  if (hasGeoRaw !== null && hasGeoRaw !== 'true' && hasGeoRaw !== 'false') throw invalid('hasGeo', 'must_be_boolean');
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
  return { q: name, country: country?.toUpperCase() ?? null, language: language?.toLowerCase() ?? null, tag: tag?.toLowerCase() ?? null, limit, offset, hasGeo: hasGeoRaw === 'true' };
}

/** Radio Browser coordinates, rounded to about a kilometre; out-of-range or 0,0 (a common placeholder) is none. */
export function geoOf(r: Record<string, unknown>): { lat: number; lon: number } | null {
  const lat = r.geo_lat;
  const lon = r.geo_long;
  if (typeof lat !== 'number' || typeof lon !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180 || (lat === 0 && lon === 0)) return null;
  return { lat: Math.round(lat * 100) / 100, lon: Math.round(lon * 100) / 100 };
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
export function toDirectoryStation(raw: unknown, withGeo = false): DirectoryStation | null {
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
  const station: DirectoryStation = { id, name, country, language, genres, streamUrl, codec, bitrateKbps: bitrate, logoUrl: httpsUrl(r.favicon), homepageUrl: httpsUrl(r.homepage) };
  if (!withGeo) return station;
  const geo = geoOf(r);
  return geo ? { ...station, geo } : null;
}

/** A community station as staff see it: blocked ones too, with the block that hides it. */
export interface AdminDirectoryStation extends DirectoryStation {
  active: boolean;
  block: { id: string; kind: 'station' | 'host'; value: string } | null;
}

type BulkList = { at: number; stations: DirectoryStation[]; truncated: boolean };
type BlockIndex = { stations: Map<string, string>; hosts: { value: string; id: string }[] };

/** The block that hides `s`, if any: its own station block first, else the first host block covering its stream. */
function blockFor(s: DirectoryStation, blocks: BlockIndex): { id: string; kind: 'station' | 'host'; value: string } | null {
  const own = blocks.stations.get(s.id);
  if (own) return { id: own, kind: 'station', value: s.id };
  const host = hostOf(s.streamUrl);
  const b = blocks.hosts.find((b) => host === b.value || host.endsWith(`.${b.value}`));
  return b ? { id: b.id, kind: 'host', value: b.value } : null;
}

/** `country` (ISO alpha-2) or `q` (part of the name), `status` all | active | inactive, `offset`. */
export function parseAdminDirectoryQuery(q: Record<string, unknown>): { country: string | null; q: string | null; status: 'all' | 'active' | 'inactive'; offset: number } {
  for (const k of Object.keys(q)) if (!['country', 'q', 'status', 'offset'].includes(k)) throw invalid(k, 'unknown_field');
  const country = one(q, 'country');
  if (country !== null && !/^[A-Za-z]{2}$/.test(country)) throw invalid('country', 'iso_3166_alpha2');
  const name = one(q, 'q')?.normalize('NFC').replace(UNSAFE, '').trim() || null;
  if (name !== null && name.length > 80) throw invalid('q', 'out_of_range', { max: 80 });
  if (!country && !name) throw invalid('country', 'required');
  const status = one(q, 'status') ?? 'all';
  if (status !== 'all' && status !== 'active' && status !== 'inactive') throw invalid('status', 'value_not_allowed');
  const offsetRaw = one(q, 'offset');
  const offset = offsetRaw === null ? 0 : /^\d{1,4}$/.test(offsetRaw) ? Number(offsetRaw) : NaN;
  if (!(offset >= 0 && offset < COUNTRY_MAX)) throw invalid('offset', 'out_of_range', { max: COUNTRY_MAX - 1 });
  return { country: country?.toUpperCase() ?? null, q: name, status, offset };
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
  private countryCache: { at: number; countries: { country: string; stations: number }[] } | null = null;
  private readonly bulkCache = new Map<string, BulkList>();
  private readonly bulkInFlight = new Map<string, Promise<BulkList>>();

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
    const blocks = await this.blockIndex();
    const stations = page.stations.filter((s) => !blockFor(s, blocks));
    return { stations, nextOffset: page.full && query.offset + query.limit <= OFFSET_MAX ? query.offset + query.limit : null, attribution: DIRECTORY_ATTRIBUTION };
  }

  private async upstream(baseUrl: string, q: DirectoryQuery): Promise<{ stations: DirectoryStation[]; full: boolean }> {
    const params = new URLSearchParams({ hidebroken: 'true', is_https: 'true', order: 'clickcount', reverse: 'true', limit: String(q.limit), offset: String(q.offset) });
    if (q.q) params.set('name', q.q);
    if (q.country) params.set('countrycode', q.country);
    if (q.language) params.set('language', q.language);
    if (q.tag) params.set('tag', q.tag);
    if (q.hasGeo) params.set('has_geo_info', 'true');
    const key = params.toString();
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached;
    const running = this.inFlight.get(key);
    if (running) return running;
    const call = this.fetchPage(baseUrl, key, q.limit, cached, q.hasGeo).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, call);
    return call;
  }

  private async fetchPage(baseUrl: string, key: string, limit: number, cached: { at: number; stations: DirectoryStation[]; full: boolean } | undefined, withGeo: boolean): Promise<{ stations: DirectoryStation[]; full: boolean }> {
    try {
      const page = await this.request(baseUrl, key, withGeo ? 'required' : 'none', UPSTREAM_MAX_BYTES);
      const entry = { at: Date.now(), stations: page.stations, full: page.raw >= limit };
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

  /** One upstream search; `raw` is how many records Radio Browser sent before our filters. Throws when it fails. */
  private async request(baseUrl: string, key: string, geo: 'required' | 'known' | 'none', maxBytes: number): Promise<{ stations: DirectoryStation[]; raw: number }> {
    const res = await this.http(`${baseUrl}/json/stations/search?${key}`, {
      headers: { accept: 'application/json', 'user-agent': `TuneDeck-API/${this.config.build}` },
      signal: AbortSignal.timeout(maxBytes > UPSTREAM_MAX_BYTES ? UPSTREAM_TIMEOUT_MS * 3 : UPSTREAM_TIMEOUT_MS),
    });
    if (res.status !== 200) throw new Error(`status ${res.status}`);
    const body = await res.text();
    if (body.length > maxBytes) throw new Error('too large');
    const raw: unknown = JSON.parse(body);
    if (!Array.isArray(raw)) throw new Error('not a list');
    const seen = new Set<string>();
    const stations = raw
      .map((r) => {
        const s = toDirectoryStation(r, geo === 'required');
        const at = s && geo === 'known' ? geoOf(r as Record<string, unknown>) : null;
        return at ? { ...s!, geo: at } : s;
      })
      .filter((s): s is DirectoryStation => !!s && !seen.has(s.id) && !!seen.add(s.id));
    return { stations, raw: raw.length };
  }

  /**
   * Stations for the web map, blocked ones left out. With a country: every station Radio Browser has there (up to
   * COUNTRY_MAX), `geo` on those with coordinates. Without: the world's most popular stations with coordinates plus
   * every one in the featured regions (FEATURED_COUNTRIES, EUROPE). One request here stands for many upstream pages,
   * so the console's single address is not rate limited page by page.
   */
  async map(country: string | null): Promise<{ stations: DirectoryStation[]; truncated: boolean; attribution: string }> {
    const list = await this.bulk(country ? `country:${country}` : 'world', (base) => (country ? this.allPages(base, { countrycode: country }, COUNTRY_MAX, 'known') : this.world(base)));
    const blocks = await this.blockIndex();
    return { stations: list.stations.filter((s) => !blockFor(s, blocks)), truncated: list.truncated, attribution: DIRECTORY_ATTRIBUTION };
  }

  /**
   * Staff list: one country's stations (or a name search) blocked ones included, each marked active or not with
   * the block that hides it, `ADMIN_PAGE` at a time.
   */
  async adminList(query: ReturnType<typeof parseAdminDirectoryQuery>): Promise<{ stations: AdminDirectoryStation[]; total: number; nextOffset: number | null; truncated: boolean; attribution: string }> {
    const list = query.country
      ? await this.bulk(`country:${query.country}`, (base) => this.allPages(base, { countrycode: query.country! }, COUNTRY_MAX, 'known'))
      : await this.bulk(`name:${query.q}`, (base) => this.allPages(base, { name: query.q! }, ADMIN_PAGE * 2, 'none'));
    const blocks = await this.blockIndex();
    const needle = query.country && query.q ? query.q.toLowerCase() : null;
    const rows = list.stations
      .filter((s) => !needle || s.name.toLowerCase().includes(needle))
      .map((s) => {
        const block = blockFor(s, blocks);
        return { ...s, active: !block, block };
      })
      .filter((s) => query.status === 'all' || s.active === (query.status === 'active'));
    const stations = rows.slice(query.offset, query.offset + ADMIN_PAGE);
    return { stations, total: rows.length, nextOffset: query.offset + ADMIN_PAGE < rows.length ? query.offset + ADMIN_PAGE : null, truncated: list.truncated, attribution: DIRECTORY_ATTRIBUTION };
  }

  /** The world map list: most popular worldwide first, then each featured country, a few countries at a time. */
  private async world(baseUrl: string): Promise<BulkList> {
    const parts: { params: Record<string, string>; max: number }[] = [
      { params: { has_geo_info: 'true' }, max: WORLD_TOP },
      ...FEATURED_COUNTRIES.map((c) => ({ params: { countrycode: c, has_geo_info: 'true' }, max: WORLD_CAP[c] ?? WORLD_CAP_FEATURED })),
      ...EUROPE.map((c) => ({ params: { countrycode: c, has_geo_info: 'true' }, max: WORLD_CAP[c] ?? WORLD_CAP_EUROPE })),
    ];
    const got: (BulkList | null)[] = new Array(parts.length).fill(null);
    let next = 0;
    const worker = async () => {
      while (next < parts.length) {
        const i = next++;
        got[i] = await this.allPages(baseUrl, parts[i].params, parts[i].max, 'required').catch(() => null);
      }
    };
    await Promise.all(Array.from({ length: BULK_CONCURRENCY }, worker));
    if (!got[0]) throw new Error('world list unavailable');
    const seen = new Set<string>();
    const stations = got.flatMap((g) => g?.stations ?? []).filter((s) => !seen.has(s.id) && !!seen.add(s.id));
    const complete = got.every(Boolean);
    return { at: complete ? Date.now() : Date.now() - BULK_TTL_MS + BULK_RETRY_MS, stations, truncated: got.some((g) => g?.truncated) || !complete };
  }

  /**
   * Pages of BULK_PAGE in listener order until a short page or `max` stations. `geo`: 'required' asks only for
   * stations with coordinates, 'known' asks for all and keeps coordinates where there are some, 'none' drops them.
   */
  private async allPages(baseUrl: string, params: Record<string, string>, max: number, geo: 'required' | 'known' | 'none'): Promise<BulkList> {
    const stations: DirectoryStation[] = [];
    const seen = new Set<string>();
    for (let offset = 0; offset < max; offset += BULK_PAGE) {
      const limit = Math.min(BULK_PAGE, max - offset);
      const qs = new URLSearchParams({ hidebroken: 'true', is_https: 'true', order: 'clickcount', reverse: 'true', ...params, limit: String(limit), offset: String(offset) });
      const page = await this.request(baseUrl, qs.toString(), geo, BULK_MAX_BYTES);
      for (const s of page.stations) if (!seen.has(s.id) && seen.add(s.id)) stations.push(s);
      if (page.raw < limit) return { at: Date.now(), stations, truncated: false };
    }
    return { at: Date.now(), stations, truncated: true };
  }

  /** A cached whole list: fresh within an hour; older (up to a day) it is answered at once and refreshed behind. */
  private async bulk(key: string, load: (baseUrl: string) => Promise<BulkList>): Promise<BulkList> {
    const dir = this.config.radioDirectory;
    if (!dir) throw new ApiError(HttpStatus.SERVICE_UNAVAILABLE, 'DEPENDENCY_UNAVAILABLE', { dependency: 'radio_directory', reason: 'not_configured' });
    const cached = this.bulkCache.get(key);
    if (cached && Date.now() - cached.at < BULK_TTL_MS) return cached;
    let running = this.bulkInFlight.get(key);
    if (!running) {
      running = load(dir.baseUrl)
        .then((entry) => {
          this.bulkCache.delete(key);
          this.bulkCache.set(key, entry);
          if (this.bulkCache.size > BULK_CACHE_MAX) this.bulkCache.delete(this.bulkCache.keys().next().value!);
          return entry;
        })
        .catch((err: unknown) => {
          this.logger.log('WARN', { eventCode: 'RADIO_DIRECTORY_UNAVAILABLE', errorName: err instanceof Error ? err.name : 'Error' });
          const old = this.bulkCache.get(key);
          if (old && Date.now() - old.at < BULK_STALE_MS) return old;
          throw new ApiError(HttpStatus.SERVICE_UNAVAILABLE, 'DEPENDENCY_UNAVAILABLE', { dependency: 'radio_directory', reason: 'unreachable' });
        })
        .finally(() => this.bulkInFlight.delete(key));
      this.bulkInFlight.set(key, running);
    }
    if (cached && Date.now() - cached.at < BULK_STALE_MS) {
      running.catch(() => undefined);
      return cached;
    }
    return running;
  }

  /**
   * Station count per country from Radio Browser, for country pins on the map. Counts are Radio Browser's own
   * (all its working stations), so a country's search can return fewer after our https and codec filters.
   */
  async countries(): Promise<{ countries: { country: string; stations: number }[]; attribution: string }> {
    const dir = this.config.radioDirectory;
    if (!dir) throw new ApiError(HttpStatus.SERVICE_UNAVAILABLE, 'DEPENDENCY_UNAVAILABLE', { dependency: 'radio_directory', reason: 'not_configured' });
    const cached = this.countryCache;
    if (cached && Date.now() - cached.at < COUNTRY_TTL_MS) return { countries: cached.countries, attribution: DIRECTORY_ATTRIBUTION };
    try {
      const res = await this.http(`${dir.baseUrl}/json/countries?hidebroken=true`, {
        headers: { accept: 'application/json', 'user-agent': `TuneDeck-API/${this.config.build}` },
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      if (res.status !== 200) throw new Error(`status ${res.status}`);
      const body = await res.text();
      if (body.length > UPSTREAM_MAX_BYTES) throw new Error('too large');
      const raw: unknown = JSON.parse(body);
      if (!Array.isArray(raw)) throw new Error('not a list');
      const counts = new Map<string, number>();
      for (const r of raw as Record<string, unknown>[]) {
        const code = typeof r?.iso_3166_1 === 'string' ? r.iso_3166_1.toUpperCase() : '';
        const n = typeof r?.stationcount === 'number' && Number.isInteger(r.stationcount) ? r.stationcount : 0;
        if (/^[A-Z]{2}$/.test(code) && n > 0) counts.set(code, (counts.get(code) ?? 0) + n);
      }
      const countries = [...counts].map(([country, stations]) => ({ country, stations })).sort((a, b) => b.stations - a.stations || a.country.localeCompare(b.country));
      this.countryCache = { at: Date.now(), countries };
      return { countries, attribution: DIRECTORY_ATTRIBUTION };
    } catch (err) {
      this.logger.log('WARN', { eventCode: 'RADIO_DIRECTORY_UNAVAILABLE', errorName: err instanceof Error ? err.name : 'Error' });
      if (cached && Date.now() - cached.at < 24 * COUNTRY_TTL_MS) return { countries: cached.countries, attribution: DIRECTORY_ATTRIBUTION };
      throw new ApiError(HttpStatus.SERVICE_UNAVAILABLE, 'DEPENDENCY_UNAVAILABLE', { dependency: 'radio_directory', reason: 'unreachable' });
    }
  }

  private async blockIndex(): Promise<BlockIndex> {
    const rows = await this.db.query<{ id: string; kind: string; value: string }>('SELECT id::text, kind, value FROM directory_blocks ORDER BY id');
    return {
      stations: new Map(rows.filter((r) => r.kind === 'station').map((r) => [r.value, r.id])),
      hosts: rows.filter((r) => r.kind === 'host').map((r) => ({ value: r.value, id: r.id })),
    };
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
  if (reason.length < 10 || reason.length > 500 || UNSAFE_TEXT.test(reason)) throw invalid('reason', 'length');
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

  /** The web map's stations: `country` for one country (all of them), none for the world map. */
  @Get('map')
  async map(@Query() q: Record<string, unknown>, @Res({ passthrough: true }) res: Response) {
    for (const k of Object.keys(q)) if (k !== 'country') throw invalid(k, 'unknown_field');
    const country = one(q, 'country');
    if (country !== null && !/^[A-Za-z]{2}$/.test(country)) throw invalid('country', 'iso_3166_alpha2');
    const result = await this.directory.map(country?.toUpperCase() ?? null);
    res.setHeader('Cache-Control', 'public, max-age=600');
    return result;
  }

  @Get('countries')
  async countries(@Query() q: Record<string, unknown>, @Res({ passthrough: true }) res: Response) {
    for (const k of Object.keys(q)) throw invalid(k, 'unknown_field');
    const result = await this.directory.countries();
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return result;
  }
}

/** Staff see a country's community stations, blocked ones included, to switch each on or off (Tar 2026-10-09). */
@Controller('v1/admin/directory/stations')
@UseGuards(AuthGuard, StaffGuard)
@RequireRoles('catalog_editor', 'admin')
export class AdminDirectoryStationsController {
  constructor(private readonly directory: DirectoryService) {}

  @Get()
  async list(@Query() q: Record<string, unknown>, @Res({ passthrough: true }) res: Response) {
    const query = parseAdminDirectoryQuery(q);
    res.setHeader('Cache-Control', 'no-store');
    return this.directory.adminList(query);
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
