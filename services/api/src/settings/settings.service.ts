import { HttpStatus, Injectable } from '@nestjs/common';
import { ApiError } from '../common/api-error';
import { Database } from '../db/database';
import { DEFAULT_SETTINGS, normalizeStored, Settings, SettingsPatch, SETTINGS_SCHEMA_VERSION } from './settings.schema';

export interface SettingsView {
  revision: number;
  schemaVersion: number;
  settings: Settings;
  updatedAt: string | null;
}

interface Row {
  revision: string;
  schema_version: number;
  value: unknown;
  updated_at: Date;
}

function toView(row: Row | undefined): SettingsView {
  if (!row) {
    return { revision: 0, schemaVersion: SETTINGS_SCHEMA_VERSION, settings: { ...DEFAULT_SETTINGS }, updatedAt: null };
  }
  return {
    revision: Number(row.revision),
    schemaVersion: row.schema_version,
    settings: normalizeStored(row.value),
    updatedAt: row.updated_at.toISOString(),
  };
}

@Injectable()
export class SettingsService {
  constructor(private readonly db: Database) {}

  /** Every query is scoped to the actor's own account id taken from the verified token. */
  async get(ownerId: string): Promise<SettingsView> {
    const rows = await this.db.query<Row>(
      'SELECT revision, schema_version, value, updated_at FROM account_preferences WHERE owner_id = $1',
      [ownerId],
    );
    return toView(rows[0]);
  }

  /**
   * Compare-and-set on the server revision: the patch applies only when the
   * client's If-Match revision equals the stored one; otherwise 412 with the
   * current revision so the client can reload and decide.
   */
  async patch(ownerId: string, expectedRevision: number, patch: SettingsPatch): Promise<SettingsView> {
    const patchJson = JSON.stringify(patch);
    const rows =
      expectedRevision === 0
        ? await this.db.query<Row>(
            `INSERT INTO account_preferences (owner_id, schema_version, revision, value)
             VALUES ($1, $2, 1, $3::jsonb || $4::jsonb)
             ON CONFLICT (owner_id) DO NOTHING
             RETURNING revision, schema_version, value, updated_at`,
            [ownerId, SETTINGS_SCHEMA_VERSION, JSON.stringify(DEFAULT_SETTINGS), patchJson],
          )
        : await this.db.query<Row>(
            `UPDATE account_preferences
             SET value = value || $3::jsonb, revision = revision + 1, schema_version = $4, updated_at = now()
             WHERE owner_id = $1 AND revision = $2
             RETURNING revision, schema_version, value, updated_at`,
            [ownerId, expectedRevision, patchJson, SETTINGS_SCHEMA_VERSION],
          );
    if (rows.length === 0) {
      const current = await this.get(ownerId);
      throw new ApiError(HttpStatus.PRECONDITION_FAILED, 'REVISION_MISMATCH', { currentRevision: current.revision });
    }
    return toView(rows[0]);
  }
}
