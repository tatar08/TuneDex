import { createHash, randomInt } from 'node:crypto';
import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Injectable, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { writeAudit } from '../audit/audit';
import { parseExportReason } from '../audit/audit-search';
import { AuthGuard } from '../auth/auth.guard';
import { ApiError } from '../common/api-error';
import { Database } from '../db/database';
import { RequireRoles, StaffGuard } from '../staff/staff';
import { DIAGNOSTICS_RETENTION_DAYS, DiagnosticsService, ReportSummary } from './diagnostics';

/** A code must be used within an hour of being made. */
export const SUPPORT_CODE_MINUTES = 60;
/** Tar's choice (2026-10-04): access lasts 7 days, the same as the reports themselves. */
export const SUPPORT_ACCESS_DAYS = 7;
/** Most recent reports shown to support, each with its events. */
const SUPPORT_REPORTS = 20;
/** No 0/O, 1/I/L or U, so a code read out over the phone is hard to get wrong. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
const CODE_LENGTH = 8;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const hashCode = (code: string) => createHash('sha256').update(code).digest('hex');
const notFound = () => new ApiError(HttpStatus.NOT_FOUND, 'NOT_FOUND');

/** Accepts the code as people type it: any case, with or without the dash or spaces. */
export function normalizeCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const code = raw.toUpperCase().replace(/[\s-]/g, '');
  return code.length === CODE_LENGTH && [...code].every((c) => ALPHABET.includes(c)) ? code : null;
}

export interface SupportGrant {
  id: string;
  grantedAt: string;
  expiresAt: string;
}

export type SupportReport = ReportSummary & {
  items: Array<{ eventName: string; monotonicMs: number; durationMs: number | null; resultCode: string | null; networkClass: string; appBuild: string; osMajor: number; deviceClass: string }>;
};

/**
 * Doc 17 "support: redacted case diagnostics that were granted". The customer makes a one-time code and reads it
 * out; the support member who enters it, with a reason, may read that customer's diagnostic reports for 7 days.
 * Only that member, not the whole team. The customer sees and can withdraw every access. Making a code, granting,
 * withdrawing and every read are audited.
 */
@Injectable()
export class SupportAccessService {
  constructor(
    private readonly db: Database,
    private readonly diagnostics: DiagnosticsService,
  ) {}

  /** A new code for the customer; an earlier unused one stops working. */
  async createCode(userId: string, requestId?: string): Promise<{ code: string; expiresAt: string }> {
    const code = Array.from({ length: CODE_LENGTH }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
    let expiresAt = '';
    await this.db.transaction(async (query) => {
      await query('DELETE FROM support_access_codes WHERE user_id = $1 AND redeemed_at IS NULL', [userId]);
      const [row] = await query<{ expires_at: Date }>(
        `INSERT INTO support_access_codes (code_hash, user_id, expires_at) VALUES ($1, $2, now() + make_interval(mins => $3)) RETURNING expires_at`,
        [hashCode(code), userId, SUPPORT_CODE_MINUTES],
      );
      expiresAt = row.expires_at.toISOString();
      await writeAudit(query, { actor: `user:${userId}`, action: 'support.code_created', targetType: 'account', targetId: userId, requestId });
    });
    return { code: `${code.slice(0, 4)}-${code.slice(4)}`, expiresAt };
  }

  /** Accesses the customer has given that are still running. */
  async grantsOf(userId: string): Promise<SupportGrant[]> {
    const rows = await this.db.query<{ id: string; created_at: Date; expires_at: Date }>(
      `SELECT id, created_at, expires_at FROM support_access_grants
        WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now() ORDER BY created_at DESC`,
      [userId],
    );
    return rows.map((r) => ({ id: r.id, grantedAt: r.created_at.toISOString(), expiresAt: r.expires_at.toISOString() }));
  }

  async revoke(userId: string, grantId: string, requestId?: string): Promise<void> {
    if (!UUID.test(grantId)) throw notFound();
    await this.db.transaction(async (query) => {
      const rows = await query(
        `UPDATE support_access_grants SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL AND expires_at > now() RETURNING id`,
        [grantId, userId],
      );
      if (!rows.length) throw notFound();
      await writeAudit(query, { actor: `user:${userId}`, action: 'support.access_revoked', targetType: 'support_access', targetId: grantId, requestId });
    });
  }

  /** Support enters the customer's code. A wrong, used, expired or other customer's code is 404 (and still audited). */
  async redeem(staff: { userId: string; requestId?: string }, customerId: string, rawCode: unknown, reason: string): Promise<SupportGrant> {
    if (!UUID.test(customerId)) throw notFound();
    const code = normalizeCode(rawCode);
    if (!code) throw new ApiError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', { field: 'code', reason: 'invalid' });
    const grant = await this.db.transaction(async (query) => {
      const [used] = await query<{ user_id: string }>(
        `UPDATE support_access_codes SET redeemed_at = now()
          WHERE code_hash = $1 AND user_id = $2 AND redeemed_at IS NULL AND expires_at > now() RETURNING user_id`,
        [hashCode(code), customerId],
      );
      if (!used) return null;
      const [row] = await query<{ id: string; created_at: Date; expires_at: Date }>(
        `INSERT INTO support_access_grants (user_id, staff_user_id, reason, expires_at)
         VALUES ($1, $2, $3, now() + make_interval(days => $4)) RETURNING id, created_at, expires_at`,
        [customerId, staff.userId, reason, SUPPORT_ACCESS_DAYS],
      );
      await writeAudit(query, {
        actor: `user:${staff.userId}`,
        action: 'support.access_granted',
        targetType: 'user',
        targetId: customerId,
        reason,
        changes: { grantId: row.id, expiresAt: row.expires_at.toISOString() },
        requestId: staff.requestId,
      });
      return { id: row.id, grantedAt: row.created_at.toISOString(), expiresAt: row.expires_at.toISOString() };
    });
    if (grant) return grant;
    await writeAudit(this.db.query.bind(this.db), {
      actor: `user:${staff.userId}`,
      action: 'support.access_refused',
      targetType: 'user',
      targetId: customerId,
      reason,
      requestId: staff.requestId,
    });
    throw notFound();
  }

  /** This staff member's running access to the customer, if any. */
  async accessFor(staffUserId: string, customerId: string): Promise<SupportGrant | null> {
    const [row] = await this.db.query<{ id: string; created_at: Date; expires_at: Date }>(
      `SELECT id, created_at, expires_at FROM support_access_grants
        WHERE user_id = $1 AND staff_user_id = $2 AND revoked_at IS NULL AND expires_at > now() ORDER BY expires_at DESC LIMIT 1`,
      [customerId, staffUserId],
    );
    return row ? { id: row.id, grantedAt: row.created_at.toISOString(), expiresAt: row.expires_at.toISOString() } : null;
  }

  /** The customer's recent reports with their events, for a staff member holding access. Every read is audited. */
  async reports(staff: { userId: string; requestId?: string }, customerId: string): Promise<{ access: SupportGrant; reports: SupportReport[]; retentionDays: number }> {
    if (!UUID.test(customerId)) throw notFound();
    const access = await this.accessFor(staff.userId, customerId);
    if (!access) throw new ApiError(HttpStatus.FORBIDDEN, 'SUPPORT_ACCESS_REQUIRED');
    const summaries = (await this.diagnostics.list(customerId)).slice(0, SUPPORT_REPORTS);
    const items = summaries.length
      ? await this.db.query<{ report_id: string; event_name: string; monotonic_ms: string; duration_ms: number | null; result_code: string | null; network_class: string; app_build: string; os_major: number; device_class: string }>(
          // No event ids or session ids: support needs what happened, not identifiers.
          `SELECT report_id, event_name, monotonic_ms, duration_ms, result_code, network_class, app_build, os_major, device_class
             FROM diagnostic_events WHERE user_id = $1 AND report_id = ANY($2::uuid[]) ORDER BY report_id, monotonic_ms, event_id`,
          [customerId, summaries.map((s) => s.id)],
        )
      : [];
    await writeAudit(this.db.query.bind(this.db), {
      actor: `user:${staff.userId}`,
      action: 'support.diagnostics_read',
      targetType: 'user',
      targetId: customerId,
      changes: { grantId: access.id, reports: summaries.length },
      requestId: staff.requestId,
    });
    return {
      access,
      retentionDays: DIAGNOSTICS_RETENTION_DAYS,
      reports: summaries.map((s) => ({
        ...s,
        items: items
          .filter((e) => e.report_id === s.id)
          .map((e) => ({
            eventName: e.event_name,
            monotonicMs: Number(e.monotonic_ms),
            durationMs: e.duration_ms,
            resultCode: e.result_code,
            networkClass: e.network_class,
            appBuild: e.app_build,
            osMajor: e.os_major,
            deviceClass: e.device_class,
          })),
      })),
    };
  }
}

/** The customer's side: make a code, see and withdraw access. */
@Controller('v1/me/support-access')
@UseGuards(AuthGuard)
export class MySupportAccessController {
  constructor(private readonly access: SupportAccessService) {}

  @Get()
  async list(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    return { grants: await this.access.grantsOf(req.actor!.userId), codeMinutes: SUPPORT_CODE_MINUTES, accessDays: SUPPORT_ACCESS_DAYS };
  }

  @Post('codes')
  @HttpCode(HttpStatus.CREATED)
  async code(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    return this.access.createCode(req.actor!.userId, req.requestId);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async revoke(@Req() req: Request, @Param('id') id: string): Promise<void> {
    await this.access.revoke(req.actor!.userId, id, req.requestId);
  }
}

/** Support's side, next to the customer lookup. */
@Controller('v1/admin/users/:userId/diagnostics')
@UseGuards(AuthGuard, StaffGuard)
@RequireRoles('support', 'admin')
export class AdminSupportDiagnosticsController {
  constructor(private readonly access: SupportAccessService) {}

  /** Body `{ code, reason }`. */
  @Post('access')
  @HttpCode(HttpStatus.CREATED)
  async redeem(@Req() req: Request, @Param('userId') userId: string, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const reason = parseExportReason(body);
    res.setHeader('Cache-Control', 'no-store');
    return this.access.redeem({ userId: req.actor!.userId, requestId: req.requestId }, userId, (body as { code?: unknown }).code, reason);
  }

  @Get()
  async reports(@Req() req: Request, @Param('userId') userId: string, @Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    return this.access.reports({ userId: req.actor!.userId, requestId: req.requestId }, userId);
  }
}
