import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Database } from '../db/database';

export const subjectHash = (subject: string) => createHash('sha256').update(subject).digest('hex');

export interface UserRecord {
  id: string;
  status: 'active' | 'deleting' | 'deleted' | 'disabled';
  email: string | null;
  email_verified: boolean;
}

/** The email claim as the identity provider asserted it, or nothing if it is missing or implausible. */
export interface EmailClaim {
  email: string;
  verified: boolean;
}
export function emailClaim(payload: Record<string, unknown>): EmailClaim | undefined {
  const e = payload.email;
  if (typeof e !== 'string' || e.length > 320 || !/^[^\s@]+@[^\s@]+$/.test(e)) return undefined;
  return { email: e, verified: payload.email_verified === true };
}

@Injectable()
export class UsersService {
  constructor(private readonly db: Database) {}

  /**
   * Finds the account for a verified OIDC subject, creating it on first sign-in. `signedInAt` (epoch seconds:
   * the token's auth_time, else iat) matters only after an account deletion: a token from a sign-in made
   * before the deletion was requested gets null instead of a new account. `email` (from the token) is kept
   * on an active account so support can find it; it is written only when it changed.
   */
  async findOrCreateBySubject(subject: string, signedInAt?: number, email?: EmailClaim): Promise<UserRecord | null> {
    const select = 'SELECT id, status, email, email_verified FROM users WHERE oidc_subject = $1';
    const existing = await this.db.query<UserRecord>(select, [subject]);
    if (existing[0]) return this.syncEmail(existing[0], email);
    const deleted = await this.db.query(
      'SELECT 1 FROM account_deletions WHERE subject_hash = $1 AND ($2::float8 IS NULL OR requested_at >= to_timestamp($2::float8)) LIMIT 1',
      [subjectHash(subject), signedInAt ?? null],
    );
    if (deleted[0]) return null;
    // First sign-in; a concurrent first request may insert the same subject, so re-read after.
    await this.db.query('INSERT INTO users (oidc_subject) VALUES ($1) ON CONFLICT (oidc_subject) DO NOTHING', [subject]);
    return this.syncEmail((await this.db.query<UserRecord>(select, [subject]))[0], email);
  }

  private async syncEmail(user: UserRecord, claim?: EmailClaim): Promise<UserRecord> {
    if (!claim || user.status !== 'active' || (user.email === claim.email && user.email_verified === claim.verified)) return user;
    await this.db.query(`UPDATE users SET email = $2, email_verified = $3 WHERE id = $1 AND status = 'active'`, [user.id, claim.email, claim.verified]);
    return { ...user, email: claim.email, email_verified: claim.verified };
  }
}
