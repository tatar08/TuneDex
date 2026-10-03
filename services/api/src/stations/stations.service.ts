import { createHash } from 'node:crypto';
import { HttpStatus, Injectable } from '@nestjs/common';
import { writeAudit } from '../audit/audit';
import { ApiError } from '../common/api-error';
import { Database } from '../db/database';
import { publishBlocker, StationDraft } from './stations.schema';

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
}

const COLUMNS =
  'id, draft, revision, pending_authors, created_at, updated_at, published, published_revision, published_at, disabled_at';

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
/** End of the expiry day in UTC: rights are valid through the whole date. */
const rightsEnd = (d: StationDraft) => (d.rightsExpiresAt ? `${d.rightsExpiresAt}T23:59:59.999Z` : null);

function statusOf(r: Row): StationStatus {
  if (r.disabled_at) return 'disabled';
  if (r.published_revision === null) return 'draft';
  return Number(r.published_revision) === Number(r.revision) ? 'published' : 'changes_pending';
}

function blockers(r: Row, actor: StationActor): string[] {
  const out: string[] = [];
  if (!actor.roles.includes('admin')) out.push('admin_role_required');
  if (r.pending_authors.includes(actor.userId)) out.push('own_change');
  if (r.published_revision !== null && Number(r.published_revision) === Number(r.revision)) out.push('already_published');
  const rights = publishBlocker(r.draft);
  if (rights) out.push(rights);
  return out;
}

function toAdminView(r: Row, actor: StationActor): AdminStationView {
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
    publishBlockers: blockers(r, actor),
  };
}

const PUBLIC_PAGE_MAX = 100;

@Injectable()
export class StationsService {
  constructor(private readonly db: Database) {}

  async list(actor: StationActor): Promise<AdminStationView[]> {
    const rows = await this.db.query<Row>(`SELECT ${COLUMNS} FROM radio_stations ORDER BY draft->>'name', id LIMIT 500`);
    return rows.map((r) => toAdminView(r, actor));
  }

  async get(actor: StationActor, id: string): Promise<AdminStationView> {
    const rows = await this.db.query<Row>(`SELECT ${COLUMNS} FROM radio_stations WHERE id = $1`, [id]);
    if (!rows[0]) throw new ApiError(HttpStatus.NOT_FOUND, 'NOT_FOUND');
    return toAdminView(rows[0], actor);
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
    return toAdminView(row, actor);
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
    return toAdminView(row, actor);
  }

  /**
   * Publishes exactly the draft revision the reviewer looked at. The reviewer must be an admin
   * who did not change the draft since its last publish, and the rights record must be complete and current.
   */
  async publish(actor: StationActor, id: string, expectedRevision: number, reason: string): Promise<AdminStationView> {
    const row = await this.db.transaction(async (query) => {
      const [current] = await query<Row>(`SELECT ${COLUMNS} FROM radio_stations WHERE id = $1 FOR UPDATE`, [id]);
      if (!current) throw new ApiError(HttpStatus.NOT_FOUND, 'NOT_FOUND');
      if (Number(current.revision) !== expectedRevision) {
        throw new ApiError(HttpStatus.PRECONDITION_FAILED, 'REVISION_MISMATCH', { currentRevision: Number(current.revision) });
      }
      const reasons = blockers(current, actor);
      if (reasons.length) throw new ApiError(HttpStatus.CONFLICT, 'PUBLISH_BLOCKED', { reasons });
      const [r] = await query<Row>(
        `UPDATE radio_stations
           SET published = draft, published_revision = revision, published_by = $2, published_at = now(),
               rights_expires_at = $3, pending_authors = '{}'
         WHERE id = $1 RETURNING ${COLUMNS}`,
        [id, actor.userId, rightsEnd(current.draft)],
      );
      await writeAudit(query, {
        actor: actorLabel(actor),
        action: 'station.publish',
        targetType: 'station',
        targetId: id,
        reason,
        changes: { revision: Number(r.revision), previousPublishedRevision: current.published_revision === null ? null : Number(current.published_revision) },
        requestId: actor.requestId,
      });
      return r;
    });
    return toAdminView(row, actor);
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
    return toAdminView(row, actor);
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
