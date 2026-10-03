import { Injectable } from '@nestjs/common';
import { Database } from '../db/database';

export interface UserRecord {
  id: string;
  status: 'active' | 'deleting' | 'disabled';
}

@Injectable()
export class UsersService {
  constructor(private readonly db: Database) {}

  /** Finds the account for a verified OIDC subject, creating it on first sign-in. */
  async findOrCreateBySubject(subject: string): Promise<UserRecord> {
    const select = 'SELECT id, status FROM users WHERE oidc_subject = $1';
    const existing = await this.db.query<UserRecord>(select, [subject]);
    if (existing[0]) return existing[0];
    // First sign-in; a concurrent first request may insert the same subject, so re-read after.
    await this.db.query('INSERT INTO users (oidc_subject) VALUES ($1) ON CONFLICT (oidc_subject) DO NOTHING', [subject]);
    return (await this.db.query<UserRecord>(select, [subject]))[0];
  }
}
