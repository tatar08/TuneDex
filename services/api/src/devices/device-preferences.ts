import { Body, Controller, Get, Headers, HttpStatus, Injectable, Param, Put, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { ApiError } from '../common/api-error';
import { Database } from '../db/database';
import { ALLOWED, normalizeStored, parseIfMatch, Settings, SETTINGS_SCHEMA_VERSION } from '../settings/settings.schema';
import { SettingsService } from '../settings/settings.service';
import { parseDeviceId } from './devices.schema';

export type Overrides = Partial<Settings>;

export interface DevicePreferencesView {
  deviceId: string;
  /** 0 until the first save. */
  revision: number;
  schemaVersion: number;
  /** Only the keys this device sets differently from the account. */
  overrides: Overrides;
  /** What the device should apply: the account settings with the overrides on top. */
  effective: Settings;
  accountRevision: number;
  updatedAt: string | null;
}

/** Keeps only allowlisted keys with allowlisted values; anything else stored earlier is dropped. */
export function normalizeOverrides(value: unknown): Overrides {
  const stored = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const field of Object.keys(ALLOWED) as (keyof typeof ALLOWED)[]) {
    const v = stored[field];
    if (typeof v === 'string' && (ALLOWED[field] as readonly string[]).includes(v)) out[field] = v;
  }
  return out as Overrides;
}

/** Body `{ overrides: { theme?, language?, cellularPolicy? } }`: the full set for the device; `{}` resets it to the account. */
export function parseOverrides(body: unknown): Overrides {
  const raw = typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as { overrides?: unknown }).overrides : undefined;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ApiError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', { field: 'overrides', reason: 'must_be_object' });
  }
  const out: Record<string, string> = {};
  for (const [field, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!Object.prototype.hasOwnProperty.call(ALLOWED, field)) throw new ApiError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', { field, reason: 'unknown_field' });
    const allowed = ALLOWED[field as keyof typeof ALLOWED] as readonly string[];
    if (typeof value !== 'string' || !allowed.includes(value)) throw new ApiError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', { field, reason: 'value_not_allowed', allowed });
    out[field] = value;
  }
  return out as Overrides;
}

interface Row {
  revision: string;
  schema_version: number;
  value: unknown;
  updated_at: Date;
}

/**
 * Doc 17 `PUT /me/devices/{id}/preferences`: a phone or car can differ from the account on the allowlisted settings
 * (theme, language, cellular policy). The owner changes them from the web or the device itself, with If-Match on
 * the device's own revision. Only the owner's active devices; others' and unknown ids are 404.
 */
@Injectable()
export class DevicePreferencesService {
  constructor(
    private readonly db: Database,
    private readonly settings: SettingsService,
  ) {}

  private async device(ownerId: string, deviceId: string): Promise<void> {
    const [d] = await this.db.query<{ revoked_at: Date | null }>('SELECT revoked_at FROM devices WHERE user_id = $1 AND id = $2', [ownerId, deviceId]);
    if (!d) throw new ApiError(HttpStatus.NOT_FOUND, 'NOT_FOUND');
    if (d.revoked_at) throw new ApiError(HttpStatus.FORBIDDEN, 'DEVICE_REVOKED');
  }

  private view(deviceId: string, row: Row | undefined, account: { revision: number; settings: Settings }): DevicePreferencesView {
    const overrides = normalizeOverrides(row?.value);
    return {
      deviceId,
      revision: Number(row?.revision ?? 0),
      schemaVersion: row?.schema_version ?? SETTINGS_SCHEMA_VERSION,
      overrides,
      effective: { ...normalizeStored(account.settings), ...overrides },
      accountRevision: account.revision,
      updatedAt: row?.updated_at.toISOString() ?? null,
    };
  }

  async get(ownerId: string, deviceId: string): Promise<DevicePreferencesView> {
    await this.device(ownerId, deviceId);
    const [rows, account] = await Promise.all([
      this.db.query<Row>('SELECT revision, schema_version, value, updated_at FROM device_preferences WHERE user_id = $1 AND device_id = $2', [ownerId, deviceId]),
      this.settings.get(ownerId),
    ]);
    return this.view(deviceId, rows[0], account);
  }

  /** Replaces the device's overrides when If-Match equals its revision (0 for none yet); otherwise 412 with the current one. */
  async put(ownerId: string, deviceId: string, expectedRevision: number, overrides: Overrides): Promise<DevicePreferencesView> {
    await this.device(ownerId, deviceId);
    const value = JSON.stringify(overrides);
    const rows =
      expectedRevision === 0
        ? await this.db.query<Row>(
            `INSERT INTO device_preferences (user_id, device_id, schema_version, revision, value) VALUES ($1, $2, $3, 1, $4::jsonb)
             ON CONFLICT (user_id, device_id) DO NOTHING RETURNING revision, schema_version, value, updated_at`,
            [ownerId, deviceId, SETTINGS_SCHEMA_VERSION, value],
          )
        : await this.db.query<Row>(
            `UPDATE device_preferences SET value = $4::jsonb, revision = revision + 1, schema_version = $3, updated_at = now()
              WHERE user_id = $1 AND device_id = $2 AND revision = $5 RETURNING revision, schema_version, value, updated_at`,
            [ownerId, deviceId, SETTINGS_SCHEMA_VERSION, value, expectedRevision],
          );
    if (rows.length === 0) {
      const current = await this.get(ownerId, deviceId);
      throw new ApiError(HttpStatus.PRECONDITION_FAILED, 'REVISION_MISMATCH', { currentRevision: current.revision });
    }
    return this.view(deviceId, rows[0], await this.settings.get(ownerId));
  }

  /** Overrides and revision of each of the owner's devices, for the device list. */
  async forOwner(ownerId: string): Promise<Map<string, { overrides: Overrides; revision: number }>> {
    const rows = await this.db.query<{ device_id: string; revision: string; value: unknown }>('SELECT device_id, revision, value FROM device_preferences WHERE user_id = $1', [ownerId]);
    return new Map(rows.map((r) => [r.device_id, { overrides: normalizeOverrides(r.value), revision: Number(r.revision) }]));
  }
}

function send(res: Response, view: DevicePreferencesView): DevicePreferencesView {
  res.setHeader('ETag', `"${view.revision}"`);
  res.setHeader('Cache-Control', 'no-store');
  return view;
}

@Controller('v1/me/devices/:deviceId/preferences')
@UseGuards(AuthGuard)
export class DevicePreferencesController {
  constructor(private readonly prefs: DevicePreferencesService) {}

  @Get()
  async get(@Req() req: Request, @Param('deviceId') deviceId: string, @Res({ passthrough: true }) res: Response) {
    return send(res, await this.prefs.get(req.actor!.userId, parseDeviceId(deviceId)));
  }

  @Put()
  async put(
    @Req() req: Request,
    @Param('deviceId') deviceId: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const id = parseDeviceId(deviceId);
    const expected = parseIfMatch(ifMatch);
    return send(res, await this.prefs.put(req.actor!.userId, id, expected, parseOverrides(body)));
  }
}
