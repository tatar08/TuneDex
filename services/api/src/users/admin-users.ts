import { Body, Controller, HttpCode, HttpStatus, Injectable, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { writeAudit } from '../audit/audit';
import { parseExportReason } from '../audit/audit-search';
import { AuthGuard } from '../auth/auth.guard';
import { ApiError } from '../common/api-error';
import { Database } from '../db/database';
import { RequireRoles, StaffGuard } from '../staff/staff';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Diagnostic reports are kept 7 days, so the count covers what support could still ask about. */
const DIAGNOSTICS_DAYS = 7;

export interface UserSupportView {
  matchedBy: 'user' | 'device';
  user: { id: string; status: 'active' | 'deleting' | 'deleted' | 'disabled'; createdAt: string; deletedAt: string | null };
  settings: { revision: number; updatedAt: string | null };
  devices: {
    id: string;
    platform: 'ios' | 'android';
    osMajor: number;
    appBuild: string;
    appliedSettingsRevision: number;
    inSync: boolean;
    createdAt: string;
    lastSeenAt: string;
    revokedAt: string | null;
  }[];
  diagnostics: { reportsLast7Days: number };
  deletion: { status: 'pending' | 'failed' | 'completed'; requestedAt: string } | null;
}

/** Body `{ query, reason }`: query is a user id or a device id the customer reads out from the app. */
export function parseLookup(body: unknown): { query: string; reason: string } {
  const query = typeof body === 'object' && body !== null ? (body as { query?: unknown }).query : undefined;
  if (typeof query !== 'string' || !UUID.test(query.trim())) throw new ApiError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', { field: 'query', reason: 'invalid' });
  return { query: query.trim().toLowerCase(), reason: parseExportReason(body) };
}

/**
 * Doc 17 /admin/users support lookup: one account by user or device id, with what support needs to help
 * (account state, devices and whether they picked up the latest settings, diagnostics count, deletion state).
 * Minimal by design: no email or name (the service never stores them), no setting values, no stations or
 * favorites, no roles. Every lookup is audited with its reason, including ones that find nothing.
 */
@Injectable()
export class AdminUsersService {
  constructor(private readonly db: Database) {}

  async lookup(actor: { userId: string; requestId?: string }, query: string, reason: string): Promise<UserSupportView> {
    const [byUser] = await this.db.query<{ id: string }>('SELECT id FROM users WHERE id = $1', [query]);
    const byDevice = byUser ? [] : await this.db.query<{ user_id: string }>('SELECT DISTINCT user_id FROM devices WHERE id = $1', [query]);
    const userId = byUser?.id ?? (byDevice.length === 1 ? byDevice[0].user_id : null);
    const matchedBy = byUser ? 'user' : 'device';

    await writeAudit(this.db.query.bind(this.db), {
      actor: `user:${actor.userId}`,
      action: 'user.lookup',
      targetType: 'user',
      targetId: userId ?? 'none',
      reason,
      changes: { matchedBy: userId ? matchedBy : null, found: Boolean(userId) },
      requestId: actor.requestId,
    });
    if (!userId) throw new ApiError(HttpStatus.NOT_FOUND, 'NOT_FOUND');

    const [[u], [prefs], devices, [diag], [deletion]] = await Promise.all([
      this.db.query<{ id: string; status: UserSupportView['user']['status']; created_at: Date; deleted_at: Date | null }>(
        'SELECT id, status, created_at, deleted_at FROM users WHERE id = $1',
        [userId],
      ),
      this.db.query<{ revision: string; updated_at: Date }>('SELECT revision, updated_at FROM account_preferences WHERE owner_id = $1', [userId]),
      this.db.query<{ id: string; platform: 'ios' | 'android'; os_major: number; app_build: string; applied_settings_revision: string; created_at: Date; last_seen_at: Date; revoked_at: Date | null }>(
        `SELECT id, platform, os_major, app_build, applied_settings_revision, created_at, last_seen_at, revoked_at
           FROM devices WHERE user_id = $1 ORDER BY revoked_at IS NOT NULL, last_seen_at DESC`,
        [userId],
      ),
      this.db.query<{ n: string }>(`SELECT count(*) AS n FROM diagnostic_reports WHERE user_id = $1 AND received_at > now() - make_interval(days => $2)`, [userId, DIAGNOSTICS_DAYS]),
      this.db.query<{ status: 'pending' | 'failed' | 'completed'; requested_at: Date }>(
        'SELECT status, requested_at FROM account_deletions WHERE user_id = $1 ORDER BY requested_at DESC LIMIT 1',
        [userId],
      ),
    ]);
    const revision = Number(prefs?.revision ?? 0);
    return {
      matchedBy,
      user: { id: u.id, status: u.status, createdAt: u.created_at.toISOString(), deletedAt: u.deleted_at?.toISOString() ?? null },
      settings: { revision, updatedAt: prefs?.updated_at.toISOString() ?? null },
      devices: devices.map((d) => ({
        id: d.id,
        platform: d.platform,
        osMajor: d.os_major,
        appBuild: d.app_build,
        appliedSettingsRevision: Number(d.applied_settings_revision),
        inSync: Number(d.applied_settings_revision) >= revision,
        createdAt: d.created_at.toISOString(),
        lastSeenAt: d.last_seen_at.toISOString(),
        revokedAt: d.revoked_at?.toISOString() ?? null,
      })),
      diagnostics: { reportsLast7Days: Number(diag.n) },
      deletion: deletion ? { status: deletion.status, requestedAt: deletion.requested_at.toISOString() } : null,
    };
  }
}

@Controller('v1/admin/users')
@UseGuards(AuthGuard, StaffGuard)
@RequireRoles('support', 'admin')
export class AdminUsersController {
  constructor(private readonly users: AdminUsersService) {}

  /** POST because every lookup is recorded with its reason. */
  @Post('lookup')
  @HttpCode(HttpStatus.OK)
  async lookup(@Req() req: Request, @Body() body: unknown, @Res({ passthrough: true }) res: Response): Promise<UserSupportView> {
    const { query, reason } = parseLookup(body);
    res.setHeader('Cache-Control', 'no-store');
    return this.users.lookup({ userId: req.actor!.userId, requestId: req.requestId }, query, reason);
  }
}
