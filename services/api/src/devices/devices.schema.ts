import { HttpStatus } from '@nestjs/common';
import { ApiError } from '../common/api-error';

export const PLATFORMS = ['ios', 'android'] as const;
export const MAX_ACTIVE_DEVICES = 20;
/** Doc 17: revoking a device needs a recent sign-in. */
export const REAUTH_MAX_AGE_SECONDS = 300;

export interface DeviceReport {
  platform: (typeof PLATFORMS)[number];
  osMajor: number;
  appBuild: string;
  appliedSettingsRevision: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BUILD = /^[0-9A-Za-z.+-]{1,32}$/;
const FIELDS = ['platform', 'osMajor', 'appBuild', 'appliedSettingsRevision'];

const invalid = (field: string, reason: string) =>
  new ApiError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', { field, reason });

export function parseDeviceId(id: string): string {
  if (!UUID.test(id)) throw invalid('deviceId', 'must_be_uuid');
  return id.toLowerCase();
}

/** Validates what a device reports about itself. Everything is allowlisted; nothing personal is accepted. */
export function parseDeviceReport(body: unknown): DeviceReport {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ApiError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', { reason: 'body_must_be_object' });
  }
  const b = body as Record<string, unknown>;
  for (const key of Object.keys(b)) if (!FIELDS.includes(key)) throw invalid(key, 'unknown_field');
  if (typeof b.platform !== 'string' || !(PLATFORMS as readonly string[]).includes(b.platform)) {
    throw invalid('platform', 'value_not_allowed');
  }
  if (!Number.isInteger(b.osMajor) || (b.osMajor as number) < 0 || (b.osMajor as number) > 99) {
    throw invalid('osMajor', 'out_of_range');
  }
  if (typeof b.appBuild !== 'string' || !BUILD.test(b.appBuild)) throw invalid('appBuild', 'malformed');
  const applied = b.appliedSettingsRevision ?? 0;
  if (!Number.isSafeInteger(applied) || (applied as number) < 0) throw invalid('appliedSettingsRevision', 'out_of_range');
  return {
    platform: b.platform as DeviceReport['platform'],
    osMajor: b.osMajor as number,
    appBuild: b.appBuild,
    appliedSettingsRevision: applied as number,
  };
}
