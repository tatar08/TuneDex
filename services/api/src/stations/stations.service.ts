import { createHash } from 'node:crypto';
import { HttpStatus, Injectable, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { writeAudit } from '../audit/audit';
import { ApiError } from '../common/api-error';
import { encodeCursor } from '../common/pagination';
import { Database } from '../db/database';
import { NewRightsRecord, rightsBlocker, RightsRecordView, RightsRow, rightsSummary, RightsSummary, todayUtc, toRightsView } from './rights';
import { StationDraft } from './stations.schema';

interface Row {
  id: string;
  draft: StationDraft;
  revision: string;
  pending_authors: string[];
  created_at: Date;
  updated_at: Date;
  published: StationDraft | null;
  published_revision: string | null;
  published_at: Date | null;
  disabled_at: Date | null;
  rights_expires_at: Date | null;
}

const COLUMNS =
  'id, draft, revision, pending_authors, created_at, updated_at, published, published_revision, published_at, disabled_at, rights_expires_at';

const RIGHTS_COLUMNS = `r.id, r.station_id, r.holder, r.basis, r.reference, r.territories, r.valid_from::text AS valid_from,
  r.expires_at::text AS expires_at, r.status, r.evidence_refs, cu.oidc_subject AS created_by, r.created_at,
  uu.oidc_subject AS updated_by, r.updated_at, ru.oidc_subject AS revoked_by, r.revoked_at, r.revoke_reason`;
const RIGHTS_FROM = `rights_records r
  LEFT JOIN users cu ON cu.id = r.created_by LEFT JOIN users uu ON uu.id = r.updated_by LEFT JOIN users ru ON ru.id = r.revoked_by`;
/** Recomputes when the public catalog may serve the station from its rights records (migration 024). */
const RECOMPUTE_RIGHTS = `UPDATE radio_stations SET rights_expires_at = station_rights_until(id) WHERE id = $1 RETURNING ${COLUMNS}`;

export type StationStatus = 'draft' | 'published' | 'changes_pending' | 'disabled';

export interface AdminStationView {
  id: string;
  revision: number;
  status: StationStatus;
  draft: StationDraft;
  published: StationDraft | null;
  publishedRevision: number | null;
  publishedAt: string | null;
  disabledAt: string | null;
  updatedAt: string;
  /** Why the viewer could not publish the current draft right now; empty when they can. */
  publishBlockers: string[];
  /** The draft country's rights from the station's records, and until when the public catalog may serve it. */
  rights: RightsSummary & { liveUntil: string | null };
}

/** One entry of a station's version history (station.* and rights.* audit events). */
export interface HistoryEntry {
  id: string;
  occurredAt: string;
  action: string;
  /** OIDC subject of a `user:` actor; null for operators and the system. */
  actorSubject: string | null;
  actor: string;
  reason: string | null;
  revision: number | null;
  changes: Record<string, unknown>;
}

export interface PublicStation {
  id: string;
  revision: number;
  name: string;
  country: string;
  language: string;
  genres: string[];
  streamUrl: string;
  codec: string;
  bitrateKbps: number | null;
}

export interface StationActor {
  userId: string;
  roles: string[];
  requestId: string;
}

const actorLabel = (a: StationActor) => `user:${a.userId}`;

function statusOf(r: Row): StationStatus {
  if (r.disabled_at) return 'disabled';
  if (r.published_revision === null) return 'draft';
  return Number(r.published_revision) === Number(r.revision) ? 'published' : 'changes_pending';
}

function blockers(r: Row, actor: StationActor, rights: RightsSummary): string[] {
  const out: string[] = [];
  if (!actor.roles.includes('admin')) out.push('admin_role_required');
  if (r.pending_authors.includes(actor.userId)) out.push('own_change');
  if (r.published_revision !== null && Number(r.published_revision) === Number(r.revision)) out.push('already_published');
  const blocker = rightsBlocker(rights);
  if (blocker) out.push(blocker);
  return out;
}

function toAdminView(r: Row, actor: StationActor, records: RightsRow[], today = todayUtc()): AdminStationView {
  const rights = rightsSummary(records, r.draft.country, today);
  return {
    id: r.id,
    revision: Number(r.revision),
    status: statusOf(r),
    draft: r.draft,
    published: r.published,
    publishedRevision: r.published_revision === null ? null : Number(r.published_revision),
    publishedAt: r.published_at?.toISOString() ?? null,
    disabledAt: r.disabled_at?.toISOString() ?? null,
    updatedAt: r.updated_at.toISOString(),
    publishBlockers: blockers(r, actor, rights),
    rights: { ...rights, liveUntil: r.rights_expires_at?.toISOString() ?? null },
  };
}

const HISTORY_ACTIONS = `(a.action LIKE 'station.%' OR a.action LIKE 'rights.%')`;

const PUBLIC_PAGE_MAX = 100;

/** How often a record whose valid_from has arrived is picked up without anyone acting. */
const RIGHTS_SWEEP_MS = 15 * 60_000;

@Injectable()
export class StationsService implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly db: Database) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.refreshRights().catch(() => undefined), RIGHTS_SWEEP_MS);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * Brings a station back once a future-dated rights record starts (expiry needs nothing: the public query
   * compares rights_expires_at with now()). Only rows that become or stay visible with a new end are written.
   */
  async refreshRights(): Promise<number> {
    const rows = await this.db.query(
      `UPDATE radio_stations s SET rights_expires_at = x.until
         FROM (SELECT id, station_rights_until(id) AS until FROM radio_stations) x
        WHERE x.id = s.id AND (x.until IS NULL OR x.until > now()) AND x.until IS DISTINCT FROM s.rights_expires_at
        RETURNING s.id`,
    );
    return rows.length;
  }

  /** Rights records of the given stations, oldest first, grouped by station. */
  private async records(ids: string[], query: Database['query'] = this.db.query.bind(this.db)): Promise<Map<string, RightsRow[]>> {
    const out = new Map<string, RightsRow[]>(ids.map((id) => [id, []]));
    if (ids.length === 0) return out;
    const rows = await query<RightsRow>(
      `SELECT ${RIGHTS_COLUMNS} FROM ${RIGHTS_FROM} WHERE r.station_id = ANY($1::uuid[]) ORDER BY r.created_at, r.id`,
      [ids],
    );
    for (const r of rows) out.get(r.station_id)?.push(r);
    return out;
  }

  private async view(r: Row, actor: StationActor, query?: Database['query']): Promise<AdminStationView> {
    return toAdminView(r, actor, (await this.records([r.id], query)).get(r.id)!);
  }

  /** One page by name, then id (Doc 17: cursor pages of at most 100). */
  async list(actor: StationActor, after: string[] | null, limit: number): Promise<{ stations: AdminStationView[]; nextCursor: string | null }> {
    const rows = after
      ? await this.db.query<Row>(
          `SELECT ${COLUMNS} FROM radio_stations WHERE (draft->>'name', id::text) > ($1, $2) ORDER BY draft->>'name', id::text LIMIT $3`,
          [after[0], after[1], limit + 1],
        )
      : await this.db.query<Row>(`SELECT ${COLUMNS} FROM radio_stations ORDER BY draft->>'name', id::text LIMIT $1`, [limit + 1]);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    const records = await this.records(page.map((r) => r.id));
    const today = todayUtc();
    return {
      stations: page.map((r) => toAdminView(r, actor, records.get(r.id)!, today)),
      nextCursor: rows.length > limit && last ? encodeCursor([last.draft.name, last.id]) : null,
    };
  }

  async get(actor: StationActor, id: string): Promise<AdminStationView> {
    const rows = await this.db.query<Row>(`SELECT ${COLUMNS} FROM radio_stations WHERE id = $1`, [id]);
    if (!rows[0]) throw new ApiError(HttpStatus.NOT_FOUND, 'NOT_FOUND');
    return this.view(rows[0], actor);
  }

  async create(actor: StationActor, draft: StationDraft): Promise<AdminStationView> {
    const row = await this.db.transaction(async (query) => {
      const [r] = await query<Row>(
        `INSERT INTO radio_stations (draft, created_by, updated_by, pending_authors)
         VALUES ($1, $2, $2, ARRAY[$2::uuid]) RETURNING ${COLUMNS}`,
        [JSON.stringify(draft), actor.userId],
      );
      await writeAudit(query, {
        actor: actorLabel(actor),
        action: 'station.create',
        targetType: 'station',
        targetId: r.id,
        changes: { fields: Object.keys(draft), revision: 1 },
        requestId: actor.requestId,
      });
      return r;
    });
    return this.view(row, actor);
  }

  /** Edits the draft with compare-and-set on `revision`. The public catalog is unchanged until someone else publishes. */
  async update(actor: StationActor, id: string, expectedRevision: number, patch: Partial<StationDraft>): Promise<AdminStationView> {
    const row = await this.db.transaction(async (query) => {
      const [current] = await query<Row>(`SELECT ${COLUMNS} FROM radio_stations WHERE id = $1 FOR UPDATE`, [id]);
      if (!current) throw new ApiError(HttpStatus.NOT_FOUND, 'NOT_FOUND');
      if (Number(current.revision) !== expectedRevision) {
        throw new ApiError(HttpStatus.PRECONDITION_FAILED, 'REVISION_MISMATCH', { currentRevision: Number(current.revision) });
      }
      const changed = (Object.keys(patch) as (keyof StationDraft)[]).filter(
        (k) => JSON.stringify(patch[k]) !== JSON.stringify(current.draft[k]),
      );
      if (changed.length === 0) return current;
      const [r] = await query<Row>(
        `UPDATE radio_stations
           SET draft = draft || $2::jsonb, revision = revision + 1, updated_by = $3, updated_at = now(),
               pending_authors = CASE WHEN $3::uuid = ANY(pending_authors) THEN pending_authors ELSE pending_authors || $3::uuid END
         WHERE id = $1 RETURNING ${COLUMNS}`,
        [id, JSON.stringify(patch), actor.userId],
      );
      await writeAudit(query, {
        actor: actorLabel(actor),
        action: 'station.update',
        targetType: 'station',
        targetId: id,
        changes: { fields: changed, revision: Number(r.revision) },
        requestId: actor.requestId,
      });
      return r;
    });
    return this.view(row, actor);
  }

  /**
   * Publishes exactly the draft revision the reviewer looked at. The reviewer must be an admin
   * who did not change the draft since its last publish, and an active, current rights record must cover the
   * draft's country. The public catalog then follows the records (rights_expires_at).
   */
  async publish(actor: StationActor, id: string, expectedRevision: number, reason: string, emergency = false): Promise<AdminStationView> {
    const row = await this.db.transaction(async (query) => {
      const [current] = await query<Row>(`SELECT ${COLUMNS} FROM radio_stations WHERE id = $1 FOR UPDATE`, [id]);
      if (!current) throw new ApiError(HttpStatus.NOT_FOUND, 'NOT_FOUND');
      if (Number(current.revision) !== expectedRevision) {
        throw new ApiError(HttpStatus.PRECONDITION_FAILED, 'REVISION_MISMATCH', { currentRevision: Number(current.revision) });
      }
      const records = (await this.records([id], query)).get(id)!;
      const all = blockers(current, actor, rightsSummary(records, current.draft.country, todayUtc()));
      // Emergency: an admin may publish their own change alone. Every other check still applies.
      const bypassed = emergency && all.includes('own_change');
      const reasons = emergency ? all.filter((b) => b !== 'own_change') : all;
      if (reasons.length) throw new ApiError(HttpStatus.CONFLICT, 'PUBLISH_BLOCKED', { reasons });
      await query(
        `UPDATE radio_stations
           SET published = draft, published_revision = revision, published_by = $2, published_at = now(), pending_authors = '{}'
         WHERE id = $1`,
        [id, actor.userId],
      );
      // After the snapshot is in place, so the published country decides.
      const [r] = await query<Row>(RECOMPUTE_RIGHTS, [id]);
      await writeAudit(query, {
        actor: actorLabel(actor),
        action: bypassed ? 'station.publish_emergency' : 'station.publish',
        targetType: 'station',
        targetId: id,
        reason,
        changes: {
          revision: Number(r.revision),
          previousPublishedRevision: current.published_revision === null ? null : Number(current.published_revision),
          ...(bypassed ? { emergency: true, reviewer: 'none' } : {}),
        },
        requestId: actor.requestId,
      });
      return r;
    });
    return this.view(row, actor);
  }

  /** Takes a station out of (or back into) the public catalog without touching its draft or published snapshot. */
  async setDisabled(actor: StationActor, id: string, disabled: boolean, reason: string): Promise<AdminStationView> {
    const row = await this.db.transaction(async (query) => {
      const [r] = await query<Row>(
        `UPDATE radio_stations SET disabled_at = CASE WHEN $2 THEN COALESCE(disabled_at, now()) ELSE NULL END
         WHERE id = $1 RETURNING ${COLUMNS}`,
        [id, disabled],
      );
      if (!r) throw new ApiError(HttpStatus.NOT_FOUND, 'NOT_FOUND');
      await writeAudit(query, {
        actor: actorLabel(actor),
        action: disabled ? 'station.disable' : 'station.enable',
        targetType: 'station',
        targetId: id,
        reason,
        requestId: actor.requestId,
      });
      return r;
    });
    return this.view(row, actor);
  }

  /** All of the station's rights records, newest first, with evidence keys (staff only). */
  async listRights(id: string): Promise<RightsRecordView[]> {
    await this.mustExist(this.db.query.bind(this.db), id);
    const today = todayUtc();
    return (await this.records([id])).get(id)!.reverse().map((r) => toRightsView(r, today, true));
  }

  /**
   * Adds a rights record. It takes effect at once: the public catalog follows the records without a new publish,
   * because rights are evidence about the station, not part of its reviewed draft.
   */
  async addRights(actor: StationActor, id: string, rec: NewRightsRecord): Promise<RightsRecordView> {
    return this.db.transaction(async (query) => {
      await this.mustExist(query, id, true);
      const [{ id: recordId }] = await query<{ id: string }>(
        `INSERT INTO rights_records (station_id, holder, basis, reference, territories, valid_from, expires_at, evidence_refs, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9) RETURNING id`,
        [id, rec.holder, rec.basis, rec.reference, rec.territories, rec.validFrom, rec.expiresAt, rec.evidenceRefs, actor.userId],
      );
      await query(RECOMPUTE_RIGHTS, [id]);
      await writeAudit(query, {
        actor: actorLabel(actor),
        action: 'rights.add',
        targetType: 'station',
        targetId: id,
        // No holder (may name a person) and no evidence keys: the audit trail is read more widely than the records.
        changes: {
          recordId,
          basis: rec.basis,
          reference: rec.reference,
          territories: rec.territories,
          validFrom: rec.validFrom,
          expiresAt: rec.expiresAt,
          evidenceCount: rec.evidenceRefs.length,
        },
        requestId: actor.requestId,
      });
      return this.record(query, recordId);
    });
  }

  /** Revokes a record with a reason. Without another covering record the station leaves the public catalog at once. */
  async revokeRights(actor: StationActor, id: string, recordId: string, reason: string): Promise<RightsRecordView> {
    return this.db.transaction(async (query) => {
      await this.mustExist(query, id, true);
      const [current] = await query<{ status: string }>('SELECT status FROM rights_records WHERE id = $1 AND station_id = $2', [recordId, id]);
      if (!current) throw new ApiError(HttpStatus.NOT_FOUND, 'NOT_FOUND');
      if (current.status === 'revoked') throw new ApiError(HttpStatus.CONFLICT, 'RIGHTS_ALREADY_REVOKED');
      await query(
        `UPDATE rights_records
            SET status = 'revoked', revoked_by = $2, revoked_at = now(), revoke_reason = $3, updated_by = $2, updated_at = now()
          WHERE id = $1`,
        [recordId, actor.userId, reason],
      );
      const [after] = await query<Row>(RECOMPUTE_RIGHTS, [id]);
      await writeAudit(query, {
        actor: actorLabel(actor),
        action: 'rights.revoke',
        targetType: 'station',
        targetId: id,
        reason,
        // Whether the published station is now out of the public catalog for lack of rights.
        changes: { recordId, hidden: after.published !== null && after.rights_expires_at !== null && after.rights_expires_at.getTime() <= Date.now() },
        requestId: actor.requestId,
      });
      return this.record(query, recordId);
    });
  }

  /** The station's version history from the audit trail (station.* and rights.*), newest first. */
  async history(id: string, after: string | null, limit: number): Promise<{ events: HistoryEntry[]; nextCursor: string | null }> {
    await this.mustExist(this.db.query.bind(this.db), id);
    if (after !== null && !/^\d{1,18}$/.test(after)) {
      throw new ApiError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', { field: 'cursor', reason: 'malformed' });
    }
    const rows = await this.db.query<{
      id: string;
      occurred_at: Date;
      action: string;
      actor: string;
      actor_subject: string | null;
      reason: string | null;
      changes: Record<string, unknown>;
    }>(
      `SELECT a.id::text, a.occurred_at, a.action, a.actor, u.oidc_subject AS actor_subject, a.reason, a.changes
         FROM audit_events a
         LEFT JOIN users u ON a.actor LIKE 'user:%' AND u.id::text = substr(a.actor, 6)
        WHERE a.target_type = 'station' AND a.target_id = $1 AND ${HISTORY_ACTIONS}
          AND ($2::bigint IS NULL OR a.id < $2::bigint)
        ORDER BY a.id DESC LIMIT $3`,
      [id, after, limit + 1],
    );
    const page = rows.slice(0, limit);
    return {
      events: page.map((r) => ({
        id: r.id,
        occurredAt: r.occurred_at.toISOString(),
        action: r.action,
        actor: r.actor,
        actorSubject: r.actor_subject,
        reason: r.reason,
        revision: typeof r.changes.revision === 'number' ? r.changes.revision : null,
        changes: r.changes,
      })),
      nextCursor: rows.length > limit && page.length ? encodeCursor([page[page.length - 1].id]) : null,
    };
  }

  private async mustExist(query: Database['query'], id: string, lock = false): Promise<void> {
    const [station] = await query<{ id: string }>(`SELECT id FROM radio_stations WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id]);
    if (!station) throw new ApiError(HttpStatus.NOT_FOUND, 'NOT_FOUND');
  }

  private async record(query: Database['query'], recordId: string): Promise<RightsRecordView> {
    const [row] = await query<RightsRow>(`SELECT ${RIGHTS_COLUMNS} FROM ${RIGHTS_FROM} WHERE r.id = $1`, [recordId]);
    return toRightsView(row, todayUtc(), false);
  }

  /**
   * Public catalog page: published, enabled stations whose rights have not expired, in a stable
   * order with an opaque cursor. Only the published snapshot is served, never a draft or rights details.
   */
  async publicPage(cursor: string | undefined, limit: number): Promise<{ stations: PublicStation[]; nextCursor: string | null; etag: string }> {
    const after = cursor ? decodeCursor(cursor) : null;
    const size = Math.min(Math.max(limit, 1), PUBLIC_PAGE_MAX);
    const rows = await this.db.query<Pick<Row, 'id' | 'published' | 'published_revision'>>(
      `SELECT id, published, published_revision FROM radio_stations
        WHERE published IS NOT NULL AND disabled_at IS NULL
          AND (rights_expires_at IS NULL OR rights_expires_at > now())
          AND ($1::uuid IS NULL OR id > $1::uuid)
        ORDER BY id LIMIT $2`,
      [after, size + 1],
    );
    const page = rows.slice(0, size);
    const stations = page.map((r): PublicStation => {
      const p = r.published!;
      return {
        id: r.id,
        revision: Number(r.published_revision),
        name: p.name,
        country: p.country,
        language: p.language,
        genres: p.genres,
        streamUrl: p.streamUrl,
        codec: p.codec,
        bitrateKbps: p.bitrateKbps,
      };
    });
    const nextCursor = rows.length > size ? Buffer.from(page[page.length - 1].id).toString('base64url') : null;
    const etag = `W/"${createHash('sha256').update(JSON.stringify([stations, nextCursor])).digest('base64url').slice(0, 27)}"`;
    return { stations, nextCursor, etag };
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function decodeCursor(cursor: string): string {
  const id = /^[A-Za-z0-9_-]{1,64}$/.test(cursor) ? Buffer.from(cursor, 'base64url').toString() : '';
  if (!UUID.test(id)) throw new ApiError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', { field: 'cursor', reason: 'malformed' });
  return id;
}
