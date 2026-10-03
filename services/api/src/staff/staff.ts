import { CanActivate, ExecutionContext, HttpStatus, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ApiError } from '../common/api-error';
import { Database } from '../db/database';

export const STAFF_ROLES = ['support', 'catalog_editor', 'operator', 'admin', 'auditor'] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

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
    req.actor.roles = roles;
    return true;
  }
}
