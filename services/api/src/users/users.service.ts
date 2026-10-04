import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Database } from '../db/database';

export const subjectHash = (subject: string) => createHash('sha256').update(subject).digest('hex');

export interface UserRecord {
  id: string;
  status: 'active' | 'deleting' | 'deleted' | 'disabled';
}

@Injectable()
export class UsersService {
  constructor(private readonly db: Database) {}

  /**
   * Finds the account for a verified OIDC subject, creating it on first sign-in. `signedInAt` (epoch seconds:
   * the token's auth_time, else iat) matters only after an account deletion: a token from a sign-in made
   * before the deletion was requested gets null instead of a new account.
   */
  async findOrCreateBySubject(subject: string, signedInAt?: number): Promise<UserRecord | null> {
    const select = 'SELECT id, status FROM users WHERE oidc_subject = $1';
    const existing = await this.db.query<UserRecord>(select, [subject]);
    if (existing[0]) return existing[0];
    const deleted = await this.db.query(
      'SELECT 1 FROM account_deletions WHERE subject_hash = $1 AND ($2::float8 IS NULL OR requested_at >= to_timestamp($2::float8)) LIMIT 1',
      [subjectHash(subject), signedInAt ?? null],
    );
    if (deleted[0]) return null;
    // First sign-in; a concurrent first request may insert the same subject, so re-read after.
    await this.db.query('INSERT INTO users (oidc_subject) VALUES ($1) ON CONFLICT (oidc_subject) DO NOTHING', [subject]);
    return (await this.db.query<UserRecord>(select, [subject]))[0];
  }
}
