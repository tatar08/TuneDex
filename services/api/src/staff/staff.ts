import { createHash } from 'node:crypto';
import { CanActivate, Controller, ExecutionContext, Get, HttpStatus, Injectable, Req, Res, SetMetadata, UseGuards } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { ApiError } from '../common/api-error';
import type { Actor } from '../common/request-context';
import { Database } from '../db/database';

export const STAFF_ROLES = ['support', 'catalog_editor', 'operator', 'admin', 'auditor'] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];
/** Doc 17: a staff session lasts at most 12 hours; MFA proven at its sign-in counts for that long. */
export const STAFF_SESSION_SECONDS = 12 * 3600;

const ROLES_KEY = 'tunedeck:roles';
/** Allows a route for any of these staff roles. Use after AuthGuard. */
export const RequireRoles = (...roles: StaffRole[]) => SetMetadata(ROLES_KEY, roles);

@Injectable()
export class StaffService {
  constructor(private readonly db: Database) {}

  /** Current, unrevoked roles. Read on every request so a revoked role stops working immediately. */
  async rolesOf(userId: string): Promise<StaffRole[]> {
    const rows = await this.db.query<{ role: StaffRole }>(
      'SELECT role FROM staff_roles WHERE user_id = $1 AND revoked_at IS NULL ORDER BY role',
      [userId],
    );
    return rows.map((r) => r.role);
  }

  /**
   * Changes whenever a role is granted or revoked. The console keeps it in the web session and ends the session
   * when it changes, so a role change takes effect on the next page (Doc 17: role changes invalidate the BFF session).
   */
  async rolesVersion(userId: string): Promise<string> {
    const rows = await this.db.query<{ id: string; revoked_at: Date | null }>('SELECT id, revoked_at FROM staff_roles WHERE user_id = $1 ORDER BY id', [userId]);
    const text = rows.map((r) => `${r.id}:${r.revoked_at?.toISOString() ?? ''}`).join(',');
    return createHash('sha256').update(text).digest('base64url').slice(0, 16);
  }

  /**
   * Doc 17: staff are signed in with MFA. True when this token proves MFA (and then remembers its Keycloak session),
   * or when its Keycloak session proved MFA within the last 12 hours. Always true in dev without STAFF_MFA_ACR.
   */
  async sessionHasMfa(actor: Actor): Promise<boolean> {
    if (actor.mfaRequired === false) return true;
    if (actor.mfaAt !== undefined) {
      if (actor.sid) {
        await this.db.query(
          `INSERT INTO staff_mfa_sessions (user_id, sid, mfa_at) VALUES ($1, $2, to_timestamp($3))
           ON CONFLICT (user_id, sid) DO UPDATE SET mfa_at = GREATEST(staff_mfa_sessions.mfa_at, EXCLUDED.mfa_at)`,
          [actor.userId, actor.sid, actor.mfaAt],
        );
        await this.db.query(`DELETE FROM staff_mfa_sessions WHERE user_id = $1 AND mfa_at < now() - make_interval(secs => $2)`, [actor.userId, STAFF_SESSION_SECONDS]);
      }
      return Date.now() / 1000 - actor.mfaAt <= STAFF_SESSION_SECONDS;
    }
    if (!actor.sid) return false;
    const rows = await this.db.query(
      `SELECT 1 FROM staff_mfa_sessions WHERE user_id = $1 AND sid = $2 AND mfa_at > now() - make_interval(secs => $3)`,
      [actor.userId, actor.sid, STAFF_SESSION_SECONDS],
    );
    return rows.length > 0;
  }
}

/** Rejects callers that hold none of the route's roles. Hidden buttons in the console are never the control. */
@Injectable()
export class StaffGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly staff: StaffService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<StaffRole[] | undefined>(ROLES_KEY, [context.getHandler(), context.getClass()]);
    const req = context.switchToHttp().getRequest<Request>();
    if (!req.actor) throw new ApiError(HttpStatus.UNAUTHORIZED, 'AUTH_REQUIRED');
    // A route without @RequireRoles is a mistake, so it fails closed.
    if (!required?.length) throw new ApiError(HttpStatus.FORBIDDEN, 'ROLE_REQUIRED');
    const roles = await this.staff.rolesOf(req.actor.userId);
    if (!roles.some((r) => required.includes(r))) throw new ApiError(HttpStatus.FORBIDDEN, 'ROLE_REQUIRED');
    // Staff pages need a session that signed in with MFA, not only the privileged actions.
    if (!(await this.staff.sessionHasMfa(req.actor))) {
      throw new ApiError(HttpStatus.UNAUTHORIZED, 'MFA_REQUIRED', { maxAgeSeconds: STAFF_SESSION_SECONDS, scope: 'session' });
    }
    req.actor.roles = roles;
    return true;
  }
}

/** Lets the console decide which staff pages to show. Real enforcement stays on each staff route. */
@Controller('v1/me/staff')
@UseGuards(AuthGuard)
export class StaffController {
  constructor(private readonly staff: StaffService) {}

  @Get()
  async roles(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<{ roles: StaffRole[]; mfa: boolean; rolesVersion: string }> {
    res.setHeader('Cache-Control', 'no-store');
    const roles = await this.staff.rolesOf(req.actor!.userId);
    // `mfa` false: the console asks a staff member to sign in again with MFA before showing staff pages.
    const mfa = roles.length > 0 ? await this.staff.sessionHasMfa(req.actor!) : false;
    return { roles, mfa, rolesVersion: await this.staff.rolesVersion(req.actor!.userId) };
  }
}
