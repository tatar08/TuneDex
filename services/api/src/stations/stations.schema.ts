import { isIP } from 'node:net';
import { HttpStatus } from '@nestjs/common';
import { ApiError } from '../common/api-error';

/**
 * Station fields catalog staff can edit. Only publicly reachable, publisher-reviewed
 * stream endpoints belong here (Doc 17); private playlists stay on the user's device.
 */
export const CODECS = ['mp3', 'aac', 'hls'] as const;
export const RIGHTS_BASES = ['owner_permission', 'broadcaster_terms', 'licensed_aggregator', 'owned_demo'] as const;

export interface StationDraft {
  name: string;
  country: string;
  language: string;
  genres: string[];
  streamUrl: string;
  codec: (typeof CODECS)[number];
  bitrateKbps: number | null;
  rightsBasis: (typeof RIGHTS_BASES)[number] | null;
  /** Where the evidence lives (contract number, ticket, email thread id). Not the evidence itself. */
  rightsReference: string | null;
  rightsExpiresAt: string | null;
}

export const EMPTY_RIGHTS = { rightsBasis: null, rightsReference: null, rightsExpiresAt: null, bitrateKbps: null };
const REQUIRED: (keyof StationDraft)[] = ['name', 'country', 'language', 'streamUrl', 'codec'];
const FIELDS: (keyof StationDraft)[] = [...REQUIRED, 'genres', 'bitrateKbps', 'rightsBasis', 'rightsReference', 'rightsExpiresAt'];

const invalid = (field: string, reason: string) => new ApiError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', { field, reason });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function parseStationId(id: string): string {
  if (!UUID.test(id)) throw invalid('stationId', 'must_be_uuid');
  return id.toLowerCase();
}

// Control characters and bidi overrides never belong in a display name.
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/;

function text(field: string, v: unknown, max: number): string {
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
export function parseStreamUrl(v: unknown): string {
  if (typeof v !== 'string' || v.length > 2048) throw invalid('streamUrl', 'must_be_url');
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    throw invalid('streamUrl', 'must_be_url');
  }
  if (url.protocol !== 'https:') throw invalid('streamUrl', 'https_required');
  if (url.username || url.password) throw invalid('streamUrl', 'credentials_not_allowed');
  if (url.hash) throw invalid('streamUrl', 'fragment_not_allowed');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (isIP(host)) throw invalid('streamUrl', 'ip_literal_not_allowed');
  if (!host.includes('.') || /(^|\.)(localhost|local|internal|localdomain|home\.arpa)$/.test(host)) {
    throw invalid('streamUrl', 'private_host');
  }
  if (url.port && url.port !== '443') throw invalid('streamUrl', 'nonstandard_port');
  return url.toString();
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
      if (typeof v !== 'string' || !(CODECS as readonly string[]).includes(v)) throw invalid(field, 'value_not_allowed');
      return v;
    case 'bitrateKbps':
      if (v === null) return null;
      if (!Number.isInteger(v) || (v as number) < 8 || (v as number) > 512) throw invalid(field, 'out_of_range');
      return v;
    case 'rightsBasis':
      if (v === null) return null;
      if (typeof v !== 'string' || !(RIGHTS_BASES as readonly string[]).includes(v)) throw invalid(field, 'value_not_allowed');
      return v;
    case 'rightsReference':
      return v === null ? null : text(field, v, 200);
    case 'rightsExpiresAt':
      if (v === null) return null;
      if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) {
        throw invalid(field, 'date_yyyy_mm_dd');
      }
      return v;
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
  const out: Record<string, unknown> = { genres: [], ...EMPTY_RIGHTS };
  for (const [k, v] of Object.entries(b)) out[k] = parseField(k as keyof StationDraft, v);
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

/** Why a draft cannot be published yet, or null when it can. */
export function publishBlocker(d: StationDraft, today = new Date()): string | null {
  if (!d.rightsBasis) return 'rights_basis_missing';
  if (!d.rightsReference) return 'rights_reference_missing';
  if (d.rightsExpiresAt && Date.parse(`${d.rightsExpiresAt}T23:59:59Z`) < today.getTime()) return 'rights_expired';
  return null;
}
