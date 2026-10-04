import { HttpStatus } from '@nestjs/common';
import { ApiError } from '../common/api-error';

/**
 * Remote app configuration, schema version 1. Only these fields exist (Doc 14: allowlisted fields,
 * disable-only critical gates). A feature switch can turn a documented feature off and back on; it can
 * never enable something the build does not already ship, and nothing here changes safety behavior.
 */
export const CONFIG_SCHEMA_VERSION = 1;

export const FEATURES = ['catalogBrowse', 'playlistImport', 'diagnosticsUpload'] as const;
export type Feature = (typeof FEATURES)[number];

export interface AppConfigPayload {
  /** Builds below this build number are asked to update before using online features; null = no minimum. */
  minSupportedBuild: { ios: number | null; android: number | null };
  /** true = on (the build's default). false switches the feature off until a later release turns it back on. */
  features: Record<Feature, boolean>;
  /** How often the app refreshes the radio catalog while in the foreground. */
  catalogRefreshHours: number;
}

/** What the apps use when there is no release yet, or the last one expired. Same as the builds' own defaults. */
export const DEFAULT_CONFIG: AppConfigPayload = {
  minSupportedBuild: { ios: null, android: null },
  features: { catalogBrowse: true, playlistImport: true, diagnosticsUpload: true },
  catalogRefreshHours: 24,
};

export const VALID_DAYS = { min: 7, max: 90, default: 30 };
const MAX_BUILD = 2_147_483_647;

const invalid = (field: string, reason: string) => new ApiError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', { field, reason });
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function onlyKeys(field: string, v: Record<string, unknown>, allowed: readonly string[]) {
  for (const key of Object.keys(v)) if (!allowed.includes(key)) throw invalid(field ? `${field}.${key}` : key, 'unknown_field');
}

function build(field: string, v: unknown): number | null {
  if (v === null) return null;
  if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > MAX_BUILD) throw invalid(field, 'must_be_build_number');
  return v as number;
}

/**
 * A partial change to the draft. Unknown fields are refused rather than ignored, so a typo can never
 * look saved. Returns the full payload with the change applied, in a fixed key order.
 */
export function applyPatch(current: AppConfigPayload, body: unknown): AppConfigPayload {
  if (!isObject(body)) throw invalid('body', 'must_be_object');
  onlyKeys('', body, ['minSupportedBuild', 'features', 'catalogRefreshHours']);
  const next: AppConfigPayload = {
    minSupportedBuild: { ...current.minSupportedBuild },
    features: { ...current.features },
    catalogRefreshHours: current.catalogRefreshHours,
  };
  if ('minSupportedBuild' in body) {
    const m = body.minSupportedBuild;
    if (!isObject(m)) throw invalid('minSupportedBuild', 'must_be_object');
    onlyKeys('minSupportedBuild', m, ['ios', 'android']);
    if ('ios' in m) next.minSupportedBuild.ios = build('minSupportedBuild.ios', m.ios);
    if ('android' in m) next.minSupportedBuild.android = build('minSupportedBuild.android', m.android);
  }
  if ('features' in body) {
    const f = body.features;
    if (!isObject(f)) throw invalid('features', 'must_be_object');
    onlyKeys('features', f, FEATURES);
    for (const key of FEATURES) {
      if (!(key in f)) continue;
      if (typeof f[key] !== 'boolean') throw invalid(`features.${key}`, 'must_be_boolean');
      next.features[key] = f[key] as boolean;
    }
  }
  if ('catalogRefreshHours' in body) {
    const h = body.catalogRefreshHours;
    if (!Number.isInteger(h) || (h as number) < 1 || (h as number) > 168) throw invalid('catalogRefreshHours', 'out_of_range');
    next.catalogRefreshHours = h as number;
  }
  return normalize(next);
}

/** Fixed key order, so the same settings always serialize (and sign) the same way. */
export function normalize(p: AppConfigPayload): AppConfigPayload {
  return {
    minSupportedBuild: { ios: p.minSupportedBuild.ios, android: p.minSupportedBuild.android },
    features: Object.fromEntries(FEATURES.map((k) => [k, p.features[k] ?? true])) as Record<Feature, boolean>,
    catalogRefreshHours: p.catalogRefreshHours,
  };
}

/** Body of publish and rollback: `{ reason, validDays? }`. */
export function parseRelease(body: unknown): { reason: string; validDays: number } {
  const b = isObject(body) ? body : {};
  onlyKeys('', b, ['reason', 'validDays']);
  const reason = typeof b.reason === 'string' ? b.reason.normalize('NFC').trim() : '';
  if (reason.length < 10 || reason.length > 500 || /[\u0000-\u001f\u007f-\u009f]/.test(reason)) throw invalid('reason', 'length');
  const validDays = b.validDays === undefined ? VALID_DAYS.default : b.validDays;
  if (!Number.isInteger(validDays) || (validDays as number) < VALID_DAYS.min || (validDays as number) > VALID_DAYS.max) {
    throw invalid('validDays', 'out_of_range');
  }
  return { reason, validDays: validDays as number };
}

export function parseReleaseId(id: string): number {
  if (!/^[1-9]\d{0,14}$/.test(id)) throw invalid('release', 'must_be_number');
  return Number(id);
}

/** Which fields differ between two payloads, as dotted paths (for the audit trail and the review screen). */
export function changedFields(a: AppConfigPayload, b: AppConfigPayload): string[] {
  const out: string[] = [];
  for (const k of ['ios', 'android'] as const) if (a.minSupportedBuild[k] !== b.minSupportedBuild[k]) out.push(`minSupportedBuild.${k}`);
  for (const k of FEATURES) if (a.features[k] !== b.features[k]) out.push(`features.${k}`);
  if (a.catalogRefreshHours !== b.catalogRefreshHours) out.push('catalogRefreshHours');
  return out;
}
