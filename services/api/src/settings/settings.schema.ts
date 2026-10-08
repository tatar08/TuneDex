import { HttpStatus } from '@nestjs/common';
import { ApiError } from '../common/api-error';

/**
 * Account-level preferences allowed in R1 (Doc 03 FR-09, Doc 17 /app/settings).
 * Proposed for the COL-00 contract; values outside these lists are rejected.
 */
export const SETTINGS_SCHEMA_VERSION = 1;

export const ALLOWED = {
  theme: ['system', 'light', 'dark'],
  // 'system': follow the device's language (the app resolves it; the web uses the browser's).
  language: ['th', 'en', 'system'],
  cellularPolicy: ['allow', 'wifi_only'],
} as const;

export type Settings = { [K in keyof typeof ALLOWED]: (typeof ALLOWED)[K][number] };
export type SettingsPatch = Partial<Settings>;

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  language: 'th',
  cellularPolicy: 'allow',
};

/** Validates a PATCH body: a non-empty object whose keys and values are all allowlisted. */
export function parseSettingsPatch(body: unknown): SettingsPatch {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ApiError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', { reason: 'body_must_be_object' });
  }
  const entries = Object.entries(body as Record<string, unknown>);
  if (entries.length === 0) {
    throw new ApiError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', { reason: 'empty_patch' });
  }
  const patch: Record<string, string> = {};
  for (const [field, value] of entries) {
    if (!Object.prototype.hasOwnProperty.call(ALLOWED, field)) {
      throw new ApiError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', { field, reason: 'unknown_field' });
    }
    const allowed = ALLOWED[field as keyof typeof ALLOWED] as readonly string[];
    if (typeof value !== 'string' || !allowed.includes(value)) {
      throw new ApiError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', {
        field,
        reason: 'value_not_allowed',
        allowed,
      });
    }
    patch[field] = value;
  }
  return patch as SettingsPatch;
}

/** Reads stored settings defensively: unknown or invalid stored values fall back to defaults. */
export function normalizeStored(value: unknown): Settings {
  const stored = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  const out = { ...DEFAULT_SETTINGS } as Record<string, string>;
  for (const field of Object.keys(ALLOWED) as (keyof typeof ALLOWED)[]) {
    const v = stored[field];
    if (typeof v === 'string' && (ALLOWED[field] as readonly string[]).includes(v)) out[field] = v;
  }
  return out as Settings;
}

/** Parses `If-Match: "<revision>"`. Missing → 428, malformed or wildcard → 400. */
export function parseIfMatch(header: string | undefined): number {
  if (header === undefined || header.trim() === '') {
    throw new ApiError(HttpStatus.PRECONDITION_REQUIRED, 'PRECONDITION_REQUIRED');
  }
  const m = /^"(\d{1,15})"$/.exec(header.trim());
  if (!m) {
    throw new ApiError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', { field: 'If-Match', reason: 'malformed' });
  }
  return Number(m[1]);
}
