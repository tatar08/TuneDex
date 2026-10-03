import type { Database } from '../db/database';

export interface AuditEntry {
  /** `user:<id>` for API callers, `operator:<label>` for the staff CLI. */
  actor: string;
  action: string;
  targetType: string;
  targetId: string;
  reason?: string | null;
  /** What changed, without secrets or personal data. */
  changes?: Record<string, unknown>;
  requestId?: string | null;
}

/**
 * Writes an audit record with the caller's query function, so it commits or rolls back
 * together with the change it describes (Doc 17: durable audit before reporting success).
 */
export async function writeAudit(query: Database['query'], e: AuditEntry): Promise<void> {
  await query(
    `INSERT INTO audit_events (actor, action, target_type, target_id, reason, changes, request_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [e.actor, e.action, e.targetType, e.targetId, e.reason ?? null, JSON.stringify(e.changes ?? {}), e.requestId ?? null],
  );
}
