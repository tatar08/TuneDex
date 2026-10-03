import { createHash, randomBytes } from 'node:crypto';
import type { TokenSet } from './oidc';

export interface Session {
  csrfToken: string;
  tokens: TokenSet;
  createdAt: number;
  lastSeenAt: number;
}

/**
 * Server-side session storage. Tokens live here and never in the browser; the
 * browser holds only an opaque random session id in an HttpOnly cookie.
 */
export interface SessionStore {
  create(tokens: TokenSet): Promise<{ id: string; session: Session }>;
  /** Returns the session and refreshes its idle timer, or null if missing or expired. */
  touch(id: string): Promise<Session | null>;
  update(id: string, session: Session): Promise<void>;
  delete(id: string): Promise<void>;
}

const keyOf = (id: string) => createHash('sha256').update(id).digest('hex');

/**
 * Single-instance store for development and tests. Production needs a shared
 * store (Redis or PostgreSQL) behind the same interface before running more
 * than one console instance.
 */
export class MemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, Session>();

  constructor(
    private readonly idleMs: number,
    private readonly absoluteMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  async create(tokens: TokenSet) {
    const id = randomBytes(32).toString('base64url');
    const t = this.now();
    const session: Session = { csrfToken: randomBytes(32).toString('base64url'), tokens, createdAt: t, lastSeenAt: t };
    this.sessions.set(keyOf(id), session);
    return { id, session };
  }

  async touch(id: string) {
    const key = keyOf(id);
    const s = this.sessions.get(key);
    if (!s) return null;
    const t = this.now();
    if (t - s.lastSeenAt > this.idleMs || t - s.createdAt > this.absoluteMs) {
      this.sessions.delete(key);
      return null;
    }
    s.lastSeenAt = t;
    return s;
  }

  async update(id: string, session: Session) {
    const key = keyOf(id);
    if (this.sessions.has(key)) this.sessions.set(key, session);
  }

  async delete(id: string) {
    this.sessions.delete(keyOf(id));
  }
}
