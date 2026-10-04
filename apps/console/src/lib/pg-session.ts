import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import type { TokenSet } from './oidc';
import type { Session, SessionLimits, SessionStore } from './session';

const CLEANUP_EVERY_MS = 10 * 60_000;

interface Row {
  payload: Buffer;
  created_at: string;
  last_seen_at: string;
}

/** What is encrypted at rest: everything secret about the session. Times stay in plain columns for expiry. */
interface Payload {
  csrfToken: string;
  tokens: TokenSet;
  staff?: boolean;
}

/**
 * Session store shared by every console instance, in PostgreSQL. Like the memory store it keys
 * rows by a hash of the session id (the cookie value never reaches the database), and it also
 * encrypts the tokens and CSRF token with AES-256-GCM under a key derived from SESSION_SECRET,
 * so a database dump alone does not hand out access tokens. Rows are bound to their key, so
 * an encrypted payload cannot be moved to another session. Changing SESSION_SECRET signs everyone out.
 */
export class PgSessionStore implements SessionStore {
  private readonly key: Buffer;
  private ready: Promise<void> | null = null;
  private lastCleanup = 0;

  constructor(
    private readonly pool: Pool,
    secret: string,
    private readonly idleMs: number,
    private readonly absoluteMs: number,
    private readonly now: () => number = Date.now,
    /** Doc 17: staff sessions idle 30 minutes, absolute 12 hours. */
    private readonly staffLimits: SessionLimits = { idleMs: 30 * 60_000, absoluteMs: 12 * 3600_000 },
  ) {
    this.key = Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), 'tunedeck-console-session-v1', 32));
  }

  static connect(databaseUrl: string, secret: string, idleMs: number, absoluteMs: number): PgSessionStore {
    const pool = new Pool({ connectionString: databaseUrl, max: 5, connectionTimeoutMillis: 2000, idleTimeoutMillis: 30_000, statement_timeout: 5000 });
    // A dropped idle connection is discarded and the next query reconnects; without this the process would crash.
    pool.on('error', () => undefined);
    return new PgSessionStore(pool, secret, idleMs, absoluteMs);
  }

  /** Creates the table on first use. Safe when several instances start at once. */
  private schema(): Promise<void> {
    this.ready ??= (async () => {
      const ddl = `CREATE TABLE IF NOT EXISTS console_sessions (
        key            text PRIMARY KEY,
        payload        bytea NOT NULL,
        created_at     bigint NOT NULL,
        last_seen_at   bigint NOT NULL,
        idle_ms        bigint NOT NULL,
        absolute_until bigint NOT NULL
      )`;
      try {
        await this.pool.query(ddl);
      } catch {
        // Two instances racing on CREATE TABLE IF NOT EXISTS can collide once; the second try sees the table.
        await this.pool.query(ddl);
      }
    })().catch((err) => {
      this.ready = null;
      throw err;
    });
    return this.ready;
  }

  private limits(staff: boolean | undefined): SessionLimits {
    return staff ? this.staffLimits : { idleMs: this.idleMs, absoluteMs: this.absoluteMs };
  }

  private seal(rowKey: string, p: Payload): Buffer {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(rowKey));
    const body = Buffer.concat([cipher.update(JSON.stringify(p), 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]);
  }

  private open(rowKey: string, sealed: Buffer): Payload | null {
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, sealed.subarray(0, 12));
      decipher.setAAD(Buffer.from(rowKey));
      decipher.setAuthTag(sealed.subarray(12, 28));
      return JSON.parse(Buffer.concat([decipher.update(sealed.subarray(28)), decipher.final()]).toString('utf8')) as Payload;
    } catch {
      return null;
    }
  }

  async create(tokens: TokenSet) {
    await this.schema();
    const id = randomBytes(32).toString('base64url');
    const key = keyOf(id);
    const t = this.now();
    const session: Session = { csrfToken: randomBytes(32).toString('base64url'), tokens, createdAt: t, lastSeenAt: t };
    const l = this.limits(false);
    await this.pool.query(
      `INSERT INTO console_sessions (key, payload, created_at, last_seen_at, idle_ms, absolute_until) VALUES ($1, $2, $3, $3, $4, $5)`,
      [key, this.seal(key, { csrfToken: session.csrfToken, tokens }), t, l.idleMs, t + l.absoluteMs],
    );
    this.cleanup(t);
    return { id, session };
  }

  async touch(id: string) {
    await this.schema();
    const key = keyOf(id);
    const t = this.now();
    const { rows } = await this.pool.query<Row>(
      `UPDATE console_sessions SET last_seen_at = $2
        WHERE key = $1 AND last_seen_at + idle_ms >= $2 AND absolute_until >= $2
        RETURNING payload, created_at, last_seen_at`,
      [key, t],
    );
    const p = rows[0] ? this.open(key, rows[0].payload) : null;
    if (!rows[0] || !p) {
      await this.pool.query('DELETE FROM console_sessions WHERE key = $1', [key]);
      return null;
    }
    return { ...p, createdAt: Number(rows[0].created_at), lastSeenAt: Number(rows[0].last_seen_at) };
  }

  async update(id: string, session: Session) {
    await this.schema();
    const key = keyOf(id);
    const l = this.limits(session.staff);
    await this.pool.query(
      `UPDATE console_sessions SET payload = $2, last_seen_at = $3, idle_ms = $4, absolute_until = created_at + $5 WHERE key = $1`,
      [key, this.seal(key, { csrfToken: session.csrfToken, tokens: session.tokens, staff: session.staff }), session.lastSeenAt, l.idleMs, l.absoluteMs],
    );
  }

  async delete(id: string) {
    await this.schema();
    await this.pool.query('DELETE FROM console_sessions WHERE key = $1', [keyOf(id)]);
  }

  /** Removes expired rows now and then, off the request path. */
  private cleanup(t: number): void {
    if (t - this.lastCleanup < CLEANUP_EVERY_MS) return;
    this.lastCleanup = t;
    void this.pool
      .query('DELETE FROM console_sessions WHERE absolute_until < $1 OR last_seen_at + idle_ms < $1', [t])
      .catch(() => undefined);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

const keyOf = (id: string) => createHash('sha256').update(id).digest('hex');
