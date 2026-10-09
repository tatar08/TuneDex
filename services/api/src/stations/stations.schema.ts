import { isIP } from 'node:net';
import { UNSAFE_TEXT } from '../common/text-safety';
import { HttpStatus } from '@nestjs/common';
import { ApiError } from '../common/api-error';

/**
 * Station fields catalog staff can edit. Only publicly reachable, publisher-reviewed
 * stream endpoints belong here (Doc 17); private playlists stay on the user's device.
 * Rights are not draft fields: they live in rights records (rights.ts).
 */
export const CODECS = ['mp3', 'aac', 'hls'] as const;

/**
 * Another endpoint for the same station, such as a lower bitrate the publisher also serves (Doc 18: data saver picks a
 * lower bitrate only when the station really offers one). The primary `streamUrl` stays the default.
 */
export interface StreamVariant {
  streamUrl: string;
  codec: (typeof CODECS)[number];
  bitrateKbps: number;
}

export const MAX_VARIANTS = 3;

export interface StationDraft {
  name: string;
  country: string;
  language: string;
  genres: string[];
  streamUrl: string;
  codec: (typeof CODECS)[number];
  bitrateKbps: number | null;
  variants: StreamVariant[];
}

const REQUIRED: (keyof StationDraft)[] = ['name', 'country', 'language', 'streamUrl', 'codec'];
const FIELDS: (keyof StationDraft)[] = [...REQUIRED, 'genres', 'bitrateKbps', 'variants'];

export const invalid = (field: string, reason: string) => new ApiError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', { field, reason });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function parseStationId(id: string, field = 'stationId'): string {
  if (!UUID.test(id)) throw invalid(field, 'must_be_uuid');
  return id.toLowerCase();
}

// Control characters, zero-width and bidi marks never belong in a display name (UNSAFE_TEXT).
export function text(field: string, v: unknown, max: number): string {
  if (typeof v !== 'string') throw invalid(field, 'must_be_string');
  const s = v.normalize('NFC').trim();
  if (s.length === 0 || s.length > max) throw invalid(field, 'length');
  if (UNSAFE_TEXT.test(s)) throw invalid(field, 'control_characters');
  return s;
}

/**
 * Stream endpoints must be plain public HTTPS URLs. The API only ever touches them through the
 * bounded health check in stream-probe.ts, which re-checks every resolved address and redirect.
 */
export function parseStreamUrl(v: unknown, field = 'streamUrl'): string {
  if (typeof v !== 'string' || v.length > 2048) throw invalid(field, 'must_be_url');
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    throw invalid(field, 'must_be_url');
  }
  if (url.protocol !== 'https:') throw invalid(field, 'https_required');
  if (url.username || url.password) throw invalid(field, 'credentials_not_allowed');
  if (url.hash) throw invalid(field, 'fragment_not_allowed');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (isIP(host)) throw invalid(field, 'ip_literal_not_allowed');
  if (!host.includes('.') || /(^|\.)(localhost|local|internal|localdomain|home\.arpa)$/.test(host)) {
    throw invalid(field, 'private_host');
  }
  if (url.port && url.port !== '443') throw invalid(field, 'nonstandard_port');
  return url.toString();
}

const parseCodec = (field: string, v: unknown) => {
  if (typeof v !== 'string' || !(CODECS as readonly string[]).includes(v)) throw invalid(field, 'value_not_allowed');
  return v as StreamVariant['codec'];
};

const parseBitrate = (field: string, v: unknown) => {
  if (!Number.isInteger(v) || (v as number) < 8 || (v as number) > 512) throw invalid(field, 'out_of_range');
  return v as number;
};

/** Up to MAX_VARIANTS alternates, each with a known bitrate so the app can pick a lower one; URLs are distinct. */
function parseVariants(v: unknown): StreamVariant[] {
  if (!Array.isArray(v) || v.length > MAX_VARIANTS) throw invalid('variants', `max_${MAX_VARIANTS}`);
  const seen = new Set<string>();
  return v.map((item, i) => {
    const at = `variants[${i}]`;
    if (typeof item !== 'object' || item === null || Array.isArray(item)) throw invalid(at, 'must_be_object');
    const o = item as Record<string, unknown>;
    for (const key of Object.keys(o)) if (!['streamUrl', 'codec', 'bitrateKbps'].includes(key)) throw invalid(`${at}.${key}`, 'unknown_field');
    for (const key of ['streamUrl', 'codec', 'bitrateKbps']) if (!(key in o)) throw invalid(`${at}.${key}`, 'required');
    const streamUrl = parseStreamUrl(o.streamUrl, `${at}.streamUrl`);
    if (seen.has(streamUrl)) throw invalid(`${at}.streamUrl`, 'duplicate');
    seen.add(streamUrl);
    return { streamUrl, codec: parseCodec(`${at}.codec`, o.codec), bitrateKbps: parseBitrate(`${at}.bitrateKbps`, o.bitrateKbps) };
  });
}

function parseField(field: keyof StationDraft, v: unknown): unknown {
  switch (field) {
    case 'name':
      return text(field, v, 80);
    case 'country':
      if (typeof v !== 'string' || !/^[A-Z]{2}$/.test(v)) throw invalid(field, 'iso_3166_alpha2');
      return v;
    case 'language':
      if (typeof v !== 'string' || !/^[a-z]{2,3}$/.test(v)) throw invalid(field, 'iso_639');
      return v;
    case 'genres':
      if (!Array.isArray(v) || v.length > 5) throw invalid(field, 'max_5');
      for (const g of v) if (typeof g !== 'string' || !/^[a-z0-9-]{2,24}$/.test(g)) throw invalid(field, 'slug');
      return [...new Set(v as string[])];
    case 'streamUrl':
      return parseStreamUrl(v);
    case 'codec':
      return parseCodec(field, v);
    case 'bitrateKbps':
      return v === null ? null : parseBitrate(field, v);
    case 'variants':
      return parseVariants(v);
  }
}

function asObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ApiError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', { reason: 'body_must_be_object' });
  }
  const b = body as Record<string, unknown>;
  for (const key of Object.keys(b)) if (!(FIELDS as string[]).includes(key)) throw invalid(key, 'unknown_field');
  return b;
}

export function parseNewStation(body: unknown): StationDraft {
  const b = asObject(body);
  for (const f of REQUIRED) if (!(f in b)) throw invalid(f, 'required');
  const out: Record<string, unknown> = { genres: [], bitrateKbps: null, variants: [] };
  for (const [k, v] of Object.entries(b)) out[k] = parseField(k as keyof StationDraft, v);
  if ((out.variants as StreamVariant[]).some((x) => x.streamUrl === out.streamUrl)) throw invalid('variants', 'duplicates_stream_url');
  return out as unknown as StationDraft;
}

export function parseStationPatch(body: unknown): Partial<StationDraft> {
  const b = asObject(body);
  if (Object.keys(b).length === 0) throw new ApiError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', { reason: 'empty_patch' });
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(b)) out[k] = parseField(k as keyof StationDraft, v);
  return out as Partial<StationDraft>;
}

/** Publish, disable and enable take a short reason that goes into the audit trail. */
export function parseReason(body: unknown): string {
  const b = (typeof body === 'object' && body !== null && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
  for (const key of Object.keys(b)) if (key !== 'reason') throw invalid(key, 'unknown_field');
  return text('reason', b.reason, 500);
}

/** Doc 17: an emergency publish by a single admin needs a reason others can review later. */
export const EMERGENCY_REASON_MIN = 20;

/**
 * Publish body: `{ reason, emergency? }`. `emergency: true` lets an admin publish their own change alone
 * (Doc 17 emergency single-admin exception); it needs a longer reason and is audited separately.
 */
export function parsePublish(body: unknown): { reason: string; emergency: boolean } {
  const b = (typeof body === 'object' && body !== null && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
  for (const key of Object.keys(b)) if (key !== 'reason' && key !== 'emergency') throw invalid(key, 'unknown_field');
  if (b.emergency !== undefined && typeof b.emergency !== 'boolean') throw invalid('emergency', 'must_be_boolean');
  const reason = text('reason', b.reason, 500);
  const emergency = b.emergency === true;
  if (emergency && reason.length < EMERGENCY_REASON_MIN) throw invalid('reason', 'too_short');
  return { reason, emergency };
}
