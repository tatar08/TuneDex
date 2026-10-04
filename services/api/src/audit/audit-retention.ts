import { Inject, Injectable, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { StructuredLogger } from '../common/logger';
import { APP_CONFIG, AppConfig } from '../config';
import { Database } from '../db/database';
import { writeAudit } from './audit';

/** Doc 17 proposed audit retention. The database refuses to remove anything younger (migration 012). */
export const AUDIT_RETENTION_DAYS = 180;
const RUN_EVERY_MS = 24 * 60 * 60 * 1000;
const CHUNK = 5000;

/**
 * Removes audit records past 180 days once a day, in small chunks, and records how many it removed as an
 * audit event of its own. Off unless AUDIT_RETENTION_ENABLED=true.
 */
@Injectable()
export class AuditRetentionService implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly db: Database,
    private readonly logger: StructuredLogger,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.auditRetentionEnabled) return;
    const run = () => void this.run().catch(() => this.logger.log('ERROR', { eventCode: 'AUDIT_RETENTION_FAILED' }));
    this.timer = setInterval(run, RUN_EVERY_MS);
    this.timer.unref();
    setTimeout(run, 60_000).unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async run(): Promise<number> {
    let removed = 0;
    for (;;) {
      const n = await this.db.transaction(async (query) => {
        await query(`SELECT set_config('tunedeck.audit_retention', 'on', true)`);
        const [{ n }] = await query<{ n: string }>(
          `WITH d AS (DELETE FROM audit_events WHERE id IN (
             SELECT id FROM audit_events WHERE occurred_at < now() - make_interval(days => $1) ORDER BY id LIMIT $2) RETURNING 1)
           SELECT count(*) AS n FROM d`,
          [AUDIT_RETENTION_DAYS, CHUNK],
        );
        return Number(n);
      });
      removed += n;
      if (n < CHUNK) break;
    }
    if (removed > 0) {
      await writeAudit(this.db.query.bind(this.db), {
        actor: 'system:audit-retention',
        action: 'audit.retention',
        targetType: 'audit',
        targetId: 'audit_events',
        changes: { removed, olderThanDays: AUDIT_RETENTION_DAYS },
      });
      this.logger.log('INFO', { eventCode: 'AUDIT_RETENTION_RAN' });
    }
    return removed;
  }
}
