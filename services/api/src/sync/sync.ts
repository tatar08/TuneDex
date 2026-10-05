import { Body, Controller, Get, HttpCode, HttpStatus, Injectable, OnApplicationBootstrap, OnApplicationShutdown, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Request, Response } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { ApiError } from '../common/api-error';
import { Database } from '../db/database';

/** Doc 06: changes and tombstones are kept 90 days; a cursor older than that must start over. */
export const SYNC_RETENTION_DAYS = 90;
export const PUSH_MAX_CHANGES = 100;
export const PUSH_MAX_BYTES = 64 * 1024;
export const PULL_DEFAULT = 50;
export const PULL_MAX = 100;
export const FAVORITE_ORDER_MAX = 9999;
const PURGE_CHUNK = 5000;
const PURGE_MAX_ROUNDS = 50;
const PURGE_EVERY_MS = 60 * 60 * 1000;

export type SyncType = 'favorite';
export type SyncOp = 'upsert' | 'delete' | 'restore';

export interface FavoriteValue {
  stationId: string;
  order: number;
}

export interface Change {
  changeId: string;
  entityId: string;
  type: SyncType;
  op: SyncOp;
  /** 0 creates the entity; otherwise the revision the device last saw. */
  baseRevision: number;
  value: FavoriteValue | null;
}

export interface EntityState {
  revision: number;
  value: FavoriteValue | null;
  deleted: boolean;
}

export type ConflictReason = 'exists' | 'not_found' | 'revision_mismatch' | 'deleted' | 'not_deleted' | 'station_already_favorite';
export type RejectReason = 'unknown_station' | 'change_id_reused';

export type ChangeResult =
  | { changeId: string; entityId: string; status: 'applied'; revision: number }
  | { changeId: string; entityId: string; status: 'conflict'; reason: ConflictReason; current: EntityState | null; existingEntityId?: string }
  | { changeId: string; entityId: string; status: 'rejected'; reason: RejectReason };

export interface PulledChange {
  entityId: string;
  type: SyncType;
  revision: number;
  value: FavoriteValue | null;
  deleted: boolean;
  updatedAt: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHANGE_FIELDS = ['changeId', 'entityId', 'type', 'op', 'baseRevision', 'value'];
const invalid = (field: string, reason: string) => new ApiError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', { field, reason });
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function uuid(v: unknown, field: string): string {
  if (typeof v !== 'string' || !UUID.test(v)) throw invalid(field, 'must_be_uuid');
  return v.toLowerCase();
}

function favoriteValue(v: unknown, field: string): FavoriteValue {
  if (!isObject(v)) throw invalid(field, 'must_be_object');
  for (const k of Object.keys(v)) if (k !== 'stationId' && k !== 'order') throw invalid(`${field}.${k}`, 'unknown_field');
  const order = v.order;
  if (typeof order !== 'number' || !Number.isInteger(order) || order < 0 || order > FAVORITE_ORDER_MAX) throw invalid(`${field}.order`, 'out_of_range');
  return { stationId: uuid(v.stationId, `${field}.stationId`), order };
}

/** Validates a whole push before anything is applied; a malformed change refuses the request with its field path. */
export function parsePush(body: unknown): { deviceId: string | null; changes: Change[] } {
  if (!isObject(body)) throw invalid('body', 'must_be_object');
  for (const k of Object.keys(body)) if (k !== 'deviceId' && k !== 'changes') throw invalid(k, 'unknown_field');
  const deviceId = body.deviceId === undefined ? null : uuid(body.deviceId, 'deviceId');
  if (!Array.isArray(body.changes) || body.changes.length === 0) throw invalid('changes', 'must_be_non_empty_array');
  if (body.changes.length > PUSH_MAX_CHANGES) throw invalid('changes', 'too_many');
  const seen = new Set<string>();
  const changes = body.changes.map((c: unknown, i: number): Change => {
    const at = `changes[${i}]`;
    if (!isObject(c)) throw invalid(at, 'must_be_object');
    for (const k of Object.keys(c)) if (!CHANGE_FIELDS.includes(k)) throw invalid(`${at}.${k}`, 'unknown_field');
    const changeId = uuid(c.changeId, `${at}.changeId`);
    if (seen.has(changeId)) throw invalid(`${at}.changeId`, 'duplicate_in_request');
    seen.add(changeId);
    if (c.type !== 'favorite') throw invalid(`${at}.type`, 'unsupported');
    if (c.op !== 'upsert' && c.op !== 'delete' && c.op !== 'restore') throw invalid(`${at}.op`, 'unsupported');
    const base = c.baseRevision;
    if (typeof base !== 'number' || !Number.isInteger(base) || base < 0) throw invalid(`${at}.baseRevision`, 'must_be_non_negative_integer');
    if (c.op !== 'upsert' && base === 0) throw invalid(`${at}.baseRevision`, 'must_name_current_revision');
    let value: FavoriteValue | null = null;
    if (c.op === 'delete') {
      if (c.value !== undefined && c.value !== null) throw invalid(`${at}.value`, 'not_allowed_on_delete');
    } else {
      value = favoriteValue(c.value, `${at}.value`);
    }
    return { changeId, entityId: uuid(c.entityId, `${at}.entityId`), type: 'favorite', op: c.op, baseRevision: base, value };
  });
  return { deviceId, changes };
}

function encodeCursor(seq: number): string {
  return Buffer.from(`s${seq}`).toString('base64url');
}

/** No cursor means a full reconciliation from the start, which is always allowed. */
function decodeCursor(cursor: unknown): number | null {
  if (cursor === undefined || cursor === '') return null;
  const raw = typeof cursor === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(cursor) ? Buffer.from(cursor, 'base64url').toString() : '';
  const m = /^s(\d{1,18})$/.exec(raw);
  if (!m) throw invalid('cursor', 'malformed');
  return Number(m[1]);
}

export function parsePull(q: Record<string, unknown>): { cursor: number | null; limit: number; deviceId: string | null } {
  for (const k of Object.keys(q)) if (!['cursor', 'limit', 'deviceId'].includes(k)) throw invalid(k, 'unknown_field');
  const limit = q.limit === undefined ? PULL_DEFAULT : Number(q.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > PULL_MAX) throw invalid('limit', 'out_of_range');
  return { cursor: decodeCursor(q.cursor), limit, deviceId: q.deviceId === undefined ? null : uuid(q.deviceId, 'deviceId') };
}

interface Row {
  entity_id: string;
  type: SyncType;
  revision: string;
  value: FavoriteValue | null;
  deleted_at: Date | null;
  updated_at: Date;
  seq: string;
}

const state = (r: Row): EntityState => ({ revision: Number(r.revision), value: r.value, deleted: r.deleted_at !== null });
const hashOf = (c: Change) => createHash('sha256').update(JSON.stringify([c.entityId, c.type, c.op, c.baseRevision, c.value])).digest('base64url');

/**
 * Doc 06 backend sync, R1 scope: station favorites and their order, per account. Every change names the
 * revision it was based on and applies only if that is still current (no wall-clock last-write-wins).
 * A delete wins over stale updates; bringing an entity back is an explicit restore of its tombstone.
 */
@Injectable()
export class SyncService implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer?: NodeJS.Timeout;

  constructor(private readonly db: Database) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.purgeExpired().catch(() => undefined), PURGE_EVERY_MS);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async push(ownerId: string, deviceId: string | null, changes: Change[]): Promise<{ results: ChangeResult[] }> {
    return this.db.transaction(async (query) => {
      // One writer per account, so seq order equals commit order and pulls never skip a change.
      await query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`sync:${ownerId}`]);
      if (deviceId) await this.checkDevice(query, ownerId, deviceId);
      const results: ChangeResult[] = [];
      for (const change of changes) {
        const bodyHash = hashOf(change);
        const [prior] = await query<{ body_hash: string; result: ChangeResult }>('SELECT body_hash, result FROM sync_changes WHERE user_id = $1 AND change_id = $2', [ownerId, change.changeId]);
        if (prior) {
          results.push(prior.body_hash === bodyHash ? prior.result : { changeId: change.changeId, entityId: change.entityId, status: 'rejected', reason: 'change_id_reused' });
          continue;
        }
        const result = await this.apply(query, ownerId, change);
        await query('INSERT INTO sync_changes (user_id, change_id, body_hash, result) VALUES ($1, $2, $3, $4)', [ownerId, change.changeId, bodyHash, JSON.stringify(result)]);
        results.push(result);
      }
      if (deviceId) await query('UPDATE devices SET last_synced_at = now() WHERE user_id = $1 AND id = $2', [ownerId, deviceId]);
      return { results };
    });
  }

  private async apply(query: Database['query'], ownerId: string, c: Change): Promise<ChangeResult> {
    const base = { changeId: c.changeId, entityId: c.entityId };
    const [row] = await query<Row>('SELECT entity_id, type, revision, value, deleted_at, updated_at, seq FROM synced_entities WHERE user_id = $1 AND entity_id = $2', [ownerId, c.entityId]);
    const conflict = (reason: ConflictReason, extra: { existingEntityId?: string } = {}): ChangeResult => ({ ...base, status: 'conflict', reason, current: row ? state(row) : null, ...extra });

    if (c.baseRevision === 0) {
      // A create may not reuse an id that exists, live or deleted (Doc 06: a stale create cannot revive a tombstone).
      if (row) return conflict('exists');
    } else {
      if (!row) return conflict('not_found');
      if (Number(row.revision) !== c.baseRevision) return conflict('revision_mismatch');
      if (c.op === 'restore' ? row.deleted_at === null : row.deleted_at !== null) return conflict(c.op === 'restore' ? 'not_deleted' : 'deleted');
    }

    if (c.value) {
      if (row?.value?.stationId !== c.value.stationId) {
        const [station] = await query<{ id: string }>(
          `SELECT id FROM radio_stations WHERE id = $1 AND published IS NOT NULL AND disabled_at IS NULL AND (rights_expires_at IS NULL OR rights_expires_at > now())`,
          [c.value.stationId],
        );
        if (!station) return { ...base, status: 'rejected', reason: 'unknown_station' };
      }
      const [other] = await query<{ entity_id: string }>(
        `SELECT entity_id FROM synced_entities WHERE user_id = $1 AND type = 'favorite' AND deleted_at IS NULL AND value->>'stationId' = $2 AND entity_id <> $3`,
        [ownerId, c.value.stationId, c.entityId],
      );
      if (other) return conflict('station_already_favorite', { existingEntityId: other.entity_id });
    }

    const revision = c.baseRevision + 1;
    if (!row) {
      await query(`INSERT INTO synced_entities (user_id, entity_id, type, revision, value) VALUES ($1, $2, $3, 1, $4)`, [ownerId, c.entityId, c.type, JSON.stringify(c.value)]);
    } else if (c.op === 'delete') {
      await query(`UPDATE synced_entities SET revision = $3, value = NULL, deleted_at = now(), updated_at = now(), seq = nextval('sync_seq') WHERE user_id = $1 AND entity_id = $2`, [ownerId, c.entityId, revision]);
    } else {
      await query(`UPDATE synced_entities SET revision = $3, value = $4, deleted_at = NULL, updated_at = now(), seq = nextval('sync_seq') WHERE user_id = $1 AND entity_id = $2`, [ownerId, c.entityId, revision, JSON.stringify(c.value)]);
    }
    return { ...base, status: 'applied', revision };
  }

  async pull(ownerId: string, cursor: number | null, limit: number, deviceId: string | null): Promise<{ changes: PulledChange[]; cursor: string; hasMore: boolean }> {
    if (deviceId) await this.checkDevice(this.db.query.bind(this.db), ownerId, deviceId);
    const [horizon] = await this.db.query<{ purged_seq: string }>('SELECT purged_seq FROM sync_horizons WHERE user_id = $1', [ownerId]);
    // A device that missed tombstones that are now gone cannot catch up incrementally; it reconciles from scratch.
    if (cursor !== null && horizon && cursor < Number(horizon.purged_seq)) throw new ApiError(HttpStatus.GONE, 'SYNC_RESET_REQUIRED');
    const rows = await this.db.query<Row>(
      `SELECT entity_id, type, revision, value, deleted_at, updated_at, seq FROM synced_entities WHERE user_id = $1 AND seq > $2 ORDER BY seq LIMIT $3`,
      [ownerId, cursor ?? 0, limit + 1],
    );
    const page = rows.slice(0, limit);
    if (deviceId) await this.db.query('UPDATE devices SET last_synced_at = now() WHERE user_id = $1 AND id = $2', [ownerId, deviceId]);
    return {
      changes: page.map((r) => ({ entityId: r.entity_id, type: r.type, revision: Number(r.revision), value: r.value, deleted: r.deleted_at !== null, updatedAt: r.updated_at.toISOString() })),
      cursor: encodeCursor(page.length ? Number(page[page.length - 1].seq) : (cursor ?? 0)),
      hasMore: rows.length > limit,
    };
  }

  /** Live favorites in the owner's order, for the web page and the export. */
  async favorites(ownerId: string): Promise<Array<{ entityId: string; revision: number; stationId: string; order: number; updatedAt: string }>> {
    const rows = await this.db.query<Row>(
      `SELECT entity_id, type, revision, value, deleted_at, updated_at, seq FROM synced_entities
        WHERE user_id = $1 AND type = 'favorite' AND deleted_at IS NULL ORDER BY (value->>'order')::int, entity_id`,
      [ownerId],
    );
    return rows.map((r) => ({ entityId: r.entity_id, revision: Number(r.revision), stationId: r.value!.stationId, order: r.value!.order, updatedAt: r.updated_at.toISOString() }));
  }

  /**
   * Removes tombstones and replay records past retention, and moves each affected account's horizon forward.
   * In chunks of PURGE_CHUNK, each its own short transaction, so a large backlog never runs into the statement
   * timeout; one instance at a time (advisory lock), the others skip the round.
   */
  async purgeExpired(): Promise<{ tombstones: number; changes: number }> {
    let tombstones = 0;
    let changes = 0;
    for (let round = 0; round < PURGE_MAX_ROUNDS; round++) {
      const r = await this.db.transaction(async (query) => {
        const [lock] = await query<{ ok: boolean }>(`SELECT pg_try_advisory_xact_lock(727011) AS ok`);
        if (!lock.ok) return null;
        const gone = await query<{ user_id: string; max_seq: string; n: string }>(
          `WITH d AS (
             DELETE FROM synced_entities WHERE (user_id, entity_id) IN (
               SELECT user_id, entity_id FROM synced_entities WHERE deleted_at < now() - make_interval(days => $1) LIMIT $2)
             RETURNING user_id, seq)
           SELECT user_id, max(seq) AS max_seq, count(*) AS n FROM d GROUP BY user_id`,
          [SYNC_RETENTION_DAYS, PURGE_CHUNK],
        );
        for (const g of gone) {
          await query(
            `INSERT INTO sync_horizons (user_id, purged_seq) VALUES ($1, $2)
             ON CONFLICT (user_id) DO UPDATE SET purged_seq = GREATEST(sync_horizons.purged_seq, EXCLUDED.purged_seq)`,
            [g.user_id, g.max_seq],
          );
        }
        const [c] = await query<{ n: string }>(
          `WITH d AS (DELETE FROM sync_changes WHERE ctid IN (
             SELECT ctid FROM sync_changes WHERE created_at < now() - make_interval(days => $1) LIMIT $2) RETURNING 1)
           SELECT count(*) AS n FROM d`,
          [SYNC_RETENTION_DAYS, PURGE_CHUNK],
        );
        return { tombstones: gone.reduce((s, g) => s + Number(g.n), 0), changes: Number(c.n) };
      });
      if (!r) break;
      tombstones += r.tombstones;
      changes += r.changes;
      if (r.tombstones < PURGE_CHUNK && r.changes < PURGE_CHUNK) break;
    }
    return { tombstones, changes };
  }

  private async checkDevice(query: Database['query'], ownerId: string, deviceId: string): Promise<void> {
    const [device] = await query<{ revoked_at: Date | null }>('SELECT revoked_at FROM devices WHERE user_id = $1 AND id = $2', [ownerId, deviceId]);
    if (!device) throw new ApiError(HttpStatus.NOT_FOUND, 'NOT_FOUND', { field: 'deviceId', reason: 'device_not_registered' });
    if (device.revoked_at) throw new ApiError(HttpStatus.FORBIDDEN, 'DEVICE_REVOKED');
  }
}

@Controller('v1/sync')
@UseGuards(AuthGuard)
export class SyncController {
  constructor(private readonly sync: SyncService) {}

  /** Applies up to 100 changes in order; each gets its own result, and a replayed changeId gets the first result again. */
  @Post('push')
  @HttpCode(HttpStatus.OK)
  async push(@Req() req: Request, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    const { deviceId, changes } = parsePush(body);
    return this.sync.push(req.actor!.userId, deviceId, changes);
  }

  /** Changes and tombstones after the cursor. Save the returned cursor only after applying the page locally. */
  @Get('pull')
  async pull(@Req() req: Request, @Query() q: Record<string, unknown>, @Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    const { cursor, limit, deviceId } = parsePull(q);
    return this.sync.pull(req.actor!.userId, cursor, limit, deviceId);
  }
}

@Controller('v1/me/favorites')
@UseGuards(AuthGuard)
export class FavoritesController {
  constructor(private readonly sync: SyncService) {}

  /** Live favorites with their revisions, in order, for the web page. Changes go through POST /v1/sync/push. */
  @Get()
  async list(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    return { favorites: await this.sync.favorites(req.actor!.userId) };
  }
}
