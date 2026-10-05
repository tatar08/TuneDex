import { randomBytes, createHash } from 'node:crypto';
import { writeAudit } from '../audit/audit';
import { Database } from '../db/database';
import { subjectHash } from '../users/users.service';
import { IdpUsersService } from './idp-users';

export interface ReconcileReport {
  checked: number;
  /** Local accounts whose Keycloak user is gone: deleted after the backup the database came from. */
  missing: string[];
  queued: number;
}

/**
 * After a database restore, accounts whose deletion finished after the backup come back with their data while
 * their Keycloak user (deleted first by the purge) is already gone. This finds them by asking Keycloak about
 * every account that still has a sign-in subject, and with `apply` queues them for deletion again: the same
 * lock-out, device sign-out and purge request as a user's own request, which the API's queue then completes.
 * Nothing changes unless every lookup succeeded, so an unreachable Keycloak never deletes anyone.
 */
export async function reconcileAfterRestore(
  db: Database,
  idp: IdpUsersService,
  opts: { apply: false } | { apply: true; by: string; reason: string },
): Promise<ReconcileReport> {
  const accounts = await db.query<{ id: string; oidc_subject: string }>(
    `SELECT id, oidc_subject FROM users WHERE status IN ('active', 'disabled') AND oidc_subject NOT LIKE 'deleted:%' ORDER BY created_at`,
  );
  const missing: string[] = [];
  for (const a of accounts) if (!(await idp.userExists(a.oidc_subject))) missing.push(a.id);
  let queued = 0;
  if (opts.apply) {
    for (const userId of missing) {
      await db.transaction(async (query) => {
        const [user] = await query<{ status: string; oidc_subject: string }>('SELECT status, oidc_subject FROM users WHERE id = $1 FOR UPDATE', [userId]);
        if (user?.status !== 'active' && user?.status !== 'disabled') return;
        await query(`UPDATE users SET status = 'deleting' WHERE id = $1`, [userId]);
        await query('UPDATE devices SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
        // Nobody holds this ticket: the account's owner already finished deleting it before the restore.
        const ticketHash = createHash('sha256').update(randomBytes(32)).digest('hex');
        await query('INSERT INTO account_deletions (ticket_hash, user_id, subject_hash) VALUES ($1, $2, $3)', [ticketHash, userId, subjectHash(user.oidc_subject)]);
        await writeAudit(query, {
          actor: `operator:${opts.by}`,
          action: 'account.restore_repurge',
          targetType: 'account',
          targetId: userId,
          reason: opts.reason,
          changes: { idpUser: 'missing' },
        });
        queued++;
      });
    }
  }
  return { checked: accounts.length, missing, queued };
}
