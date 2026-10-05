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

export const PLATFORMS = ['ios', 'android'] as const;
export type Platform = (typeof PLATFORMS)[number];
export const CHANNELS = ['staging', 'production'] as const;
export type Channel = (typeof CHANNELS)[number];

/** Which apps a release is for. A client outside it ignores the release and keeps the newest one that fits it. */
export type Targets = Record<Platform, { include: boolean; minBuild: number | null; maxBuild: number | null }>;

export const DEFAULT_TARGETS: Targets = {
  ios: { include: true, minBuild: null, maxBuild: null },
  android: { include: true, minBuild: null, maxBuild: null },
};

export function normalizeTargets(t: Partial<Targets> | null | undefined): Targets {
  const one = (p: Platform) => ({
    include: t?.[p]?.include ?? true,
    minBuild: t?.[p]?.minBuild ?? null,
    maxBuild: t?.[p]?.maxBuild ?? null,
  });
  return { ios: one('ios'), android: one('android') };
}

/** A partial change to the targets, e.g. `{ android: { minBuild: 120 } }`. */
export function applyTargetsPatch(current: Targets, body: unknown): Targets {
  if (!isObject(body)) throw invalid('targets', 'must_be_object');
  onlyKeys('targets', body, PLATFORMS);
  const next = normalizeTargets(current);
  for (const p of PLATFORMS) {
    if (!(p in body)) continue;
    const v = body[p];
    if (!isObject(v)) throw invalid(`targets.${p}`, 'must_be_object');
    onlyKeys(`targets.${p}`, v, ['include', 'minBuild', 'maxBuild']);
    if ('include' in v) {
      if (typeof v.include !== 'boolean') throw invalid(`targets.${p}.include`, 'must_be_boolean');
      next[p].include = v.include;
    }
    if ('minBuild' in v) next[p].minBuild = build(`targets.${p}.minBuild`, v.minBuild);
    if ('maxBuild' in v) next[p].maxBuild = build(`targets.${p}.maxBuild`, v.maxBuild);
    if (next[p].minBuild !== null && next[p].maxBuild !== null && next[p].minBuild! > next[p].maxBuild!) {
      throw invalid(`targets.${p}.maxBuild`, 'below_min_build');
    }
  }
  if (!PLATFORMS.some((p) => next[p].include)) throw invalid('targets', 'no_platform');
  return next;
}

/** Dotted paths that differ between two target sets. */
export function changedTargets(a: Targets, b: Targets): string[] {
  const out: string[] = [];
  for (const p of PLATFORMS) for (const k of ['include', 'minBuild', 'maxBuild'] as const) if (a[p][k] !== b[p][k]) out.push(`targets.${p}.${k}`);
  return out;
}

/**
 * Whether a client fits the targets. A client that does not say its platform fits only a release for every
 * platform and build; one that says its platform but not its build fits only a release without a build range.
 */
export function fits(t: Targets, platform: Platform | null, buildNumber: number | null): boolean {
  if (!platform) return PLATFORMS.every((p) => t[p].include && t[p].minBuild === null && t[p].maxBuild === null);
  const r = t[platform];
  if (!r.include) return false;
  if (buildNumber === null) return r.minBuild === null && r.maxBuild === null;
  return (r.minBuild === null || buildNumber >= r.minBuild) && (r.maxBuild === null || buildNumber <= r.maxBuild);
}

/** Query of GET /v1/config: `channel` (default production), `platform`, `build`. */
export function parseClientQuery(q: Record<string, unknown>): { channel: Channel; platform: Platform | null; build: number | null } {
  const channel = q.channel === undefined ? 'production' : q.channel;
  if (!CHANNELS.includes(channel as Channel)) throw invalid('channel', 'value_not_allowed');
  const platform = q.platform === undefined ? null : q.platform;
  if (platform !== null && !PLATFORMS.includes(platform as Platform)) throw invalid('platform', 'value_not_allowed');
  let buildNumber: number | null = null;
  if (q.build !== undefined) {
    if (typeof q.build !== 'string' || !/^[1-9]\d{0,9}$/.test(q.build) || Number(q.build) > MAX_BUILD) throw invalid('build', 'must_be_build_number');
    if (platform === null) throw invalid('platform', 'required');
    buildNumber = Number(q.build);
  }
  return { channel: channel as Channel, platform: platform as Platform | null, build: buildNumber };
}

/** Body of publish: `{ reason, validDays?, emergency? }`. An emergency needs a reason of 20+ characters. */
export function parsePublishRelease(body: unknown): { reason: string; validDays: number; emergency: boolean } {
  const b = isObject(body) ? { ...body } : {};
  const emergency = b.emergency;
  delete b.emergency;
  if (emergency !== undefined && typeof emergency !== 'boolean') throw invalid('emergency', 'must_be_boolean');
  const parsed = parseRelease(b);
  if (emergency === true && parsed.reason.length < 20) throw invalid('reason', 'too_short');
  return { ...parsed, emergency: emergency === true };
}
