import { HttpStatus } from '@nestjs/common';
import { ApiError } from '../common/api-error';
import { invalid, text } from './stations.schema';

/**
 * Rights records (Doc 17 catalog_editor "rights evidence"): who allowed a station to be served, on what basis,
 * where, and until when. A station is publishable only with an active, current record covering its country.
 */
export const RIGHTS_BASES = ['owner_permission', 'broadcaster_terms', 'licensed_aggregator', 'owned_demo'] as const;
export type RightsBasis = (typeof RIGHTS_BASES)[number];

export interface NewRightsRecord {
  holder: string;
  basis: RightsBasis;
  /** Where the evidence lives (contract number, ticket, email thread id). Not the evidence itself. */
  reference: string;
  territories: string[];
  validFrom: string;
  expiresAt: string | null;
  /** Opaque keys of files in private storage. Staff-only; never a URL, never in the public catalog or the audit trail. */
  evidenceRefs: string[];
}

/** One rights_records row as the service reads it (dates as YYYY-MM-DD text, actors as OIDC subjects). */
export interface RightsRow {
  id: string;
  station_id: string;
  holder: string;
  basis: RightsBasis;
  reference: string;
  territories: string[];
  valid_from: string;
  expires_at: string | null;
  status: 'active' | 'revoked';
  evidence_refs: string[];
  created_by: string | null;
  created_at: Date;
  updated_by: string | null;
  updated_at: Date;
  revoked_by: string | null;
  revoked_at: Date | null;
  revoke_reason: string | null;
}

/** `scheduled`: active but valid_from is still ahead; `expired`: active but expires_at has passed. */
export type EffectiveRightsStatus = 'active' | 'scheduled' | 'expired' | 'revoked';

export interface RightsRecordView {
  id: string;
  holder: string;
  basis: RightsBasis;
  reference: string;
  territories: string[];
  validFrom: string;
  expiresAt: string | null;
  status: 'active' | 'revoked';
  effectiveStatus: EffectiveRightsStatus;
  evidenceCount: number;
  /** Only in the staff list (GET .../rights). */
  evidenceRefs?: string[];
  /** OIDC subject of the staff member; null for records back-filled by migration 024. */
  createdBy: string | null;
  createdAt: string;
  updatedBy: string | null;
  updatedAt: string;
  revokedBy: string | null;
  revokedAt: string | null;
  revokeReason: string | null;
}

export type RightsState = 'current' | 'missing' | 'territory' | 'not_yet_valid' | 'expired';

/** The station's rights at a glance, for lists and the publish gate. */
export interface RightsSummary {
  state: RightsState;
  /** End date of the record that decides `state` (null: no end date, or no record). */
  expiresAt: string | null;
  reference: string | null;
}

/** Today's date in UTC: rights are valid from the start of valid_from through the end of expires_at (UTC). */
export const todayUtc = (now = new Date()) => now.toISOString().slice(0, 10);

const DATE = /^\d{4}-\d{2}-\d{2}$/;
function date(field: string, v: unknown): string {
  if (typeof v !== 'string' || !DATE.test(v) || new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) !== v) {
    throw invalid(field, 'date_yyyy_mm_dd');
  }
  return v;
}

/** Storage keys such as `rights/2026/contract-014.pdf`: no scheme, host, `..` or empty segments. */
const EVIDENCE_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9._-]+)*$/;

const FIELDS = ['holder', 'basis', 'reference', 'territories', 'validFrom', 'expiresAt', 'evidenceRefs'];

export function parseRightsRecord(body: unknown, now = new Date()): NewRightsRecord {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ApiError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', { reason: 'body_must_be_object' });
  }
  const b = body as Record<string, unknown>;
  for (const key of Object.keys(b)) if (!FIELDS.includes(key)) throw invalid(key, 'unknown_field');
  for (const f of ['holder', 'basis', 'reference', 'territories']) if (!(f in b)) throw invalid(f, 'required');

  if (typeof b.basis !== 'string' || !(RIGHTS_BASES as readonly string[]).includes(b.basis)) throw invalid('basis', 'value_not_allowed');
  if (!Array.isArray(b.territories) || b.territories.length < 1 || b.territories.length > 250) throw invalid('territories', 'length');
  for (const t of b.territories) if (typeof t !== 'string' || !/^[A-Z]{2}$/.test(t)) throw invalid('territories', 'iso_3166_alpha2');
  const validFrom = b.validFrom === undefined ? todayUtc(now) : date('validFrom', b.validFrom);
  const expiresAt = b.expiresAt === undefined || b.expiresAt === null ? null : date('expiresAt', b.expiresAt);
  if (expiresAt && expiresAt < validFrom) throw invalid('expiresAt', 'before_valid_from');
  const refs = b.evidenceRefs ?? [];
  if (!Array.isArray(refs) || refs.length > 10) throw invalid('evidenceRefs', 'max_10');
  for (const r of refs) {
    if (typeof r !== 'string' || r.length > 200 || !EVIDENCE_KEY.test(r) || r.split('/').some((p) => p === '.' || p === '..')) {
      throw invalid('evidenceRefs', 'opaque_key');
    }
  }
  return {
    holder: text('holder', b.holder, 200),
    basis: b.basis as RightsBasis,
    reference: text('reference', b.reference, 200),
    territories: [...new Set(b.territories as string[])].sort(),
    validFrom,
    expiresAt,
    evidenceRefs: [...new Set(refs as string[])],
  };
}

export function effectiveStatus(r: Pick<RightsRow, 'status' | 'valid_from' | 'expires_at'>, today: string): EffectiveRightsStatus {
  if (r.status === 'revoked') return 'revoked';
  if (r.expires_at && r.expires_at < today) return 'expired';
  if (r.valid_from > today) return 'scheduled';
  return 'active';
}

/** The record with the latest end among `rows` (an open-ended one wins). */
function latest(rows: RightsRow[]): RightsRow {
  return rows.reduce((a, b) => (a.expires_at === null ? a : b.expires_at === null || b.expires_at > a.expires_at ? b : a));
}

/**
 * What the station's records say for `country` today. Must agree with station_rights_until() in migration 024,
 * which decides public visibility from the same rule.
 */
export function rightsSummary(rows: RightsRow[], country: string, today: string): RightsSummary {
  const active = rows.filter((r) => r.status === 'active');
  if (active.length === 0) return { state: 'missing', expiresAt: null, reference: null };
  const covering = active.filter((r) => r.territories.includes(country));
  if (covering.length === 0) return { state: 'territory', expiresAt: null, reference: null };
  const pick = (state: RightsState, among: RightsRow[]): RightsSummary => {
    const r = latest(among);
    return { state, expiresAt: r.expires_at, reference: r.reference };
  };
  const current = covering.filter((r) => effectiveStatus(r, today) === 'active');
  if (current.length) return pick('current', current);
  const scheduled = covering.filter((r) => effectiveStatus(r, today) === 'scheduled');
  if (scheduled.length) return pick('not_yet_valid', scheduled);
  return pick('expired', covering);
}

/** Publish blocker code for a summary, or null when the rights allow publishing. */
export const rightsBlocker = (s: RightsSummary): string | null => (s.state === 'current' ? null : `rights_${s.state}`);

export function toRightsView(r: RightsRow, today: string, withEvidence: boolean): RightsRecordView {
  return {
    id: r.id,
    holder: r.holder,
    basis: r.basis,
    reference: r.reference,
    territories: r.territories,
    validFrom: r.valid_from,
    expiresAt: r.expires_at,
    status: r.status,
    effectiveStatus: effectiveStatus(r, today),
    evidenceCount: r.evidence_refs.length,
    ...(withEvidence ? { evidenceRefs: r.evidence_refs } : {}),
    createdBy: r.created_by,
    createdAt: r.created_at.toISOString(),
    updatedBy: r.updated_by,
    updatedAt: r.updated_at.toISOString(),
    revokedBy: r.revoked_by,
    revokedAt: r.revoked_at?.toISOString() ?? null,
    revokeReason: r.revoke_reason,
  };
}
