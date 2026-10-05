import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, KeyObject } from 'node:crypto';
import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Inject, Injectable, Param, Patch, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { CompactSign } from 'jose';
import { writeAudit } from '../audit/audit';
import { AuthGuard } from '../auth/auth.guard';
import { requireRecentMfa } from '../auth/recent-sign-in';
import { ApiError } from '../common/api-error';
import { APP_CONFIG, AppConfig } from '../config';
import { Database } from '../db/database';
import { parseIfMatch } from '../settings/settings.schema';
import { RequireRoles, StaffGuard } from '../staff/staff';
import {
  AppConfigPayload,
  applyPatch,
  applyTargetsPatch,
  changedFields,
  changedTargets,
  Channel,
  CONFIG_SCHEMA_VERSION,
  DEFAULT_CONFIG,
  DEFAULT_TARGETS,
  fits,
  normalize,
  normalizeTargets,
  parseClientQuery,
  parsePublishRelease,
  parseRelease,
  parseReleaseId,
  Platform,
  Targets,
} from './app-config.schema';

/** The signed document the apps receive. `release` 0 means "no release yet: built-in defaults". */
export interface SignedConfig {
  schemaVersion: number;
  release: number;
  /** The channel this release was published on, and the platforms and builds it is for. */
  environment: Channel;
  targets: Targets;
  publishedAt: string | null;
  expiresAt: string | null;
  /**
   * When this copy was signed, and until when an app may accept it as fresh (at most a day, never past
   * expiresAt). A captured old copy cannot be replayed later to roll apps back to an older release.
   */
  issuedAt: string;
  validUntil: string;
  config: AppConfigPayload;
}

/** A signed copy is re-signed after this long, so validUntil keeps moving forward. */
const RESIGN_AFTER_MS = 60 * 60_000;
/** A publish or rollback reaches every instance's public answer within this. */
const RELEASES_CACHE_MS = 5_000;
/** How long an app may accept one signed copy. */
const SIGNED_COPY_VALID_MS = 24 * 60 * 60_000;

export interface ReleaseView {
  release: number;
  schemaVersion: number;
  environment: Channel;
  targets: Targets;
  config: AppConfigPayload;
  /** For a production release: the staging release it promoted. */
  stagedRelease: number | null;
  /** Whether a different admin approved it (false for staging, rollbacks and emergencies). */
  reviewed: boolean;
  emergency: boolean;
  rollbackOf: number | null;
  draftRevision: number | null;
  publishedAt: string;
  expiresAt: string;
  reason: string;
  /** Whether the person looking published it (names stay out of the console for now). */
  publishedByYou: boolean;
}

export interface AdminConfigView {
  draft: { config: AppConfigPayload; targets: Targets; revision: number; updatedAt: string | null; changedSinceRelease: string[] };
  /** The production release everyone without a narrower target gets. */
  current: ReleaseView | null;
  /** The newest staging release, and whether it is the draft as it is now (required before production). */
  staged: ReleaseView | null;
  stagedIsDraft: boolean;
  /** Why the viewer cannot stage the draft right now; empty when they can. */
  stageBlockers: string[];
  releases: ReleaseView[];
  /** Why the viewer cannot publish the draft right now; empty when they can. */
  publishBlockers: string[];
  defaults: AppConfigPayload;
  signingKeyId: string;
}

interface DraftRow {
  payload: AppConfigPayload;
  targets: Targets;
  revision: string;
  updated_at: Date;
  pending_authors: string[];
}
interface ReleaseRow {
  release: string;
  schema_version: number;
  payload: AppConfigPayload;
  draft_revision: string | null;
  rollback_of: string | null;
  published_by: string;
  published_at: Date;
  expires_at: Date;
  reason: string;
  environment: Channel;
  targets: Targets;
  staged_release: string | null;
  authors: string[];
  reviewed_by: string | null;
  emergency: boolean;
}
const RELEASE_COLUMNS =
  'release, schema_version, payload, draft_revision, rollback_of, published_by, published_at, expires_at, reason, environment, targets, staged_release, authors, reviewed_by, emergency';
const DRAFT_COLUMNS = 'payload, targets, revision, updated_at, pending_authors';

export interface ConfigActor {
  userId: string;
  roles: string[];
  requestId: string;
}
const actorOf = (req: Request): ConfigActor => ({ userId: req.actor!.userId, roles: req.actor!.roles ?? [], requestId: req.requestId });

/** Ed25519 key that signs what GET /v1/config serves. The apps pin the public key in their build. */
export const CONFIG_SIGNER = Symbol('CONFIG_SIGNER');
export interface ConfigSigner {
  key: KeyObject;
  keyId: string;
  publicKeyPem: string;
}

/** Builds the signer from CONFIG_SIGNING_KEY (PKCS#8 PEM). Dev without one gets a throwaway key per start. */
export function createConfigSigner(pem: string | null): ConfigSigner {
  const key = pem ? createPrivateKey(pem) : generateKeyPairSync('ed25519').privateKey;
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('CONFIG_SIGNING_KEY must be an Ed25519 private key');
  const pub = createPublicKey(key);
  const der = pub.export({ type: 'spki', format: 'der' });
  return {
    key,
    keyId: createHash('sha256').update(der).digest('base64url').slice(0, 16),
    publicKeyPem: pub.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

const releaseView = (r: ReleaseRow, viewer: string): ReleaseView => ({
  release: Number(r.release),
  schemaVersion: r.schema_version,
  environment: r.environment,
  targets: normalizeTargets(r.targets),
  config: normalize(r.payload),
  stagedRelease: r.staged_release === null ? null : Number(r.staged_release),
  reviewed: r.reviewed_by !== null,
  emergency: r.emergency,
  rollbackOf: r.rollback_of === null ? null : Number(r.rollback_of),
  draftRevision: r.draft_revision === null ? null : Number(r.draft_revision),
  publishedAt: r.published_at.toISOString(),
  expiresAt: r.expires_at.toISOString(),
  reason: r.reason,
  publishedByYou: r.published_by === viewer,
});

/**
 * Doc 17 configuration rollout: one draft, edited with compare-and-set; a different admin publishes exactly
 * the revision they reviewed; a rollback re-releases an earlier payload as a new release. Every step is audited
 * in the same transaction, and releases can never be edited.
 */
@Injectable()
export class AppConfigService {
  /** Signed documents by release (0 = defaults, per channel); a release never changes, so entries never go stale. */
  private readonly cache = new Map<string, { body: { jws: string } & SignedConfig; etag: string; signedAt: number }>();
  private readonly releaseRows = new Map<Channel, { at: number; rows: ReleaseRow[] }>();

  constructor(
    private readonly db: Database,
    @Inject(CONFIG_SIGNER) private readonly signer: ConfigSigner,
  ) {}

  private async draftRow(query = this.db.query.bind(this.db), lock = false): Promise<DraftRow> {
    const [row] = await query<DraftRow>(`SELECT ${DRAFT_COLUMNS} FROM app_config_draft WHERE id = 1${lock ? ' FOR UPDATE' : ''}`);
    if (row) return row;
    // First use: the draft starts from the defaults at revision 0.
    await query(`INSERT INTO app_config_draft (id, payload) VALUES (1, $1) ON CONFLICT (id) DO NOTHING`, [JSON.stringify(DEFAULT_CONFIG)]);
    const [created] = await query<DraftRow>(`SELECT ${DRAFT_COLUMNS} FROM app_config_draft WHERE id = 1${lock ? ' FOR UPDATE' : ''}`);
    return created;
  }

  /** The newest release on a channel. */
  private async latest(query = this.db.query.bind(this.db), environment: Channel = 'production'): Promise<ReleaseRow | null> {
    const [row] = await query<ReleaseRow>(`SELECT ${RELEASE_COLUMNS} FROM app_config_releases WHERE environment = $1 ORDER BY release DESC LIMIT 1`, [environment]);
    return row ?? null;
  }

  /** Draft fields that differ from a release (or from the defaults when there is none). */
  private changes(draft: DraftRow, release: ReleaseRow | null): string[] {
    return [
      ...changedFields(release ? normalize(release.payload) : DEFAULT_CONFIG, normalize(draft.payload)),
      ...changedTargets(release ? normalizeTargets(release.targets) : DEFAULT_TARGETS, normalizeTargets(draft.targets)),
    ];
  }

  private stageBlockers(draft: DraftRow, current: ReleaseRow | null, staged: ReleaseRow | null, actor: ConfigActor): string[] {
    const out: string[] = [];
    if (!actor.roles.includes('admin')) out.push('admin_role_required');
    if (staged && Number(staged.draft_revision) === Number(draft.revision)) out.push('already_staged');
    if (this.changes(draft, current).length === 0) out.push('no_changes');
    return out;
  }

  /** Production needs the draft staged as it is now, and a different admin from everyone who changed it. */
  private blockers(draft: DraftRow, current: ReleaseRow | null, staged: ReleaseRow | null, actor: ConfigActor): string[] {
    const out: string[] = [];
    if (!actor.roles.includes('admin')) out.push('admin_role_required');
    if (draft.pending_authors.includes(actor.userId)) out.push('own_change');
    if (this.changes(draft, current).length === 0) out.push('no_changes');
    else if (!staged || Number(staged.draft_revision) !== Number(draft.revision)) out.push('not_staged');
    return out;
  }

  async view(actor: ConfigActor): Promise<AdminConfigView> {
    const draft = await this.draftRow();
    const releases = await this.db.query<ReleaseRow>(`SELECT ${RELEASE_COLUMNS} FROM app_config_releases ORDER BY release DESC LIMIT 20`);
    const current = await this.latest();
    const staged = await this.latest(undefined, 'staging');
    return {
      draft: {
        config: normalize(draft.payload),
        targets: normalizeTargets(draft.targets),
        revision: Number(draft.revision),
        updatedAt: Number(draft.revision) === 0 ? null : draft.updated_at.toISOString(),
        changedSinceRelease: this.changes(draft, current),
      },
      current: current ? releaseView(current, actor.userId) : null,
      staged: staged ? releaseView(staged, actor.userId) : null,
      stagedIsDraft: !!staged && Number(staged.draft_revision) === Number(draft.revision),
      stageBlockers: this.stageBlockers(draft, current, staged, actor),
      releases: releases.map((r) => releaseView(r, actor.userId)),
      publishBlockers: this.blockers(draft, current, staged, actor),
      defaults: DEFAULT_CONFIG,
      signingKeyId: this.signer.keyId,
    };
  }

  async updateDraft(actor: ConfigActor, expectedRevision: number, body: unknown): Promise<AdminConfigView> {
    await this.db.transaction(async (query) => {
      const draft = await this.draftRow(query, true);
      if (Number(draft.revision) !== expectedRevision) {
        throw new ApiError(HttpStatus.PRECONDITION_FAILED, 'REVISION_MISMATCH', { currentRevision: Number(draft.revision) });
      }
      const before = normalize(draft.payload);
      const beforeTargets = normalizeTargets(draft.targets);
      const { targets: targetsPatch, ...configPatch } = (typeof body === 'object' && body !== null && !Array.isArray(body) ? body : { body }) as Record<string, unknown>;
      const next = applyPatch(before, configPatch);
      const nextTargets = targetsPatch === undefined ? beforeTargets : applyTargetsPatch(beforeTargets, targetsPatch);
      const fields = [...changedFields(before, next), ...changedTargets(beforeTargets, nextTargets)];
      if (fields.length === 0) return;
      const [r] = await query<{ revision: string }>(
        `UPDATE app_config_draft
            SET payload = $1, targets = $3, revision = revision + 1, updated_by = $2, updated_at = now(),
                pending_authors = CASE WHEN $2::uuid = ANY(pending_authors) THEN pending_authors ELSE pending_authors || $2::uuid END
          WHERE id = 1 RETURNING revision`,
        [JSON.stringify(next), actor.userId, JSON.stringify(nextTargets)],
      );
      await writeAudit(query, {
        actor: `user:${actor.userId}`,
        action: 'config.update',
        targetType: 'config',
        targetId: 'draft',
        changes: { fields, revision: Number(r.revision), values: Object.fromEntries(fields.map((f) => [f, f.startsWith('targets.') ? pick(nextTargets, f.slice(8)) : pick(next, f)])) },
        requestId: actor.requestId,
      });
    });
    this.releaseRows.clear();
    return this.view(actor);
  }

  /**
   * Doc 17 staging step: releases the draft to the staging channel (internal test builds) so it can be tried
   * before review. Any admin may stage, including the author. Production later promotes exactly this release.
   */
  async stage(actor: ConfigActor, expectedRevision: number, body: unknown): Promise<AdminConfigView> {
    const { reason, validDays } = parseRelease(body);
    await this.db.transaction(async (query) => {
      const draft = await this.draftRow(query, true);
      if (Number(draft.revision) !== expectedRevision) {
        throw new ApiError(HttpStatus.PRECONDITION_FAILED, 'REVISION_MISMATCH', { currentRevision: Number(draft.revision) });
      }
      const current = await this.latest(query);
      const staged = await this.latest(query, 'staging');
      const reasons = this.stageBlockers(draft, current, staged, actor);
      if (reasons.length) throw new ApiError(HttpStatus.CONFLICT, 'PUBLISH_BLOCKED', { reasons });
      const [r] = await query<{ release: string }>(
        `INSERT INTO app_config_releases (schema_version, payload, targets, environment, draft_revision, authors, published_by, expires_at, reason)
         VALUES ($1, $2, $3, 'staging', $4, $5, $6, now() + make_interval(days => $7), $8) RETURNING release`,
        [CONFIG_SCHEMA_VERSION, JSON.stringify(normalize(draft.payload)), JSON.stringify(normalizeTargets(draft.targets)), Number(draft.revision), draft.pending_authors, actor.userId, validDays, reason],
      );
      await writeAudit(query, {
        actor: `user:${actor.userId}`,
        action: 'config.stage',
        targetType: 'config',
        targetId: r.release,
        reason,
        changes: { draftRevision: Number(draft.revision), fields: this.changes(draft, current), validDays },
        requestId: actor.requestId,
      });
    });
    this.releaseRows.clear();
    return this.view(actor);
  }

  /**
   * Promotes the staged draft to production. The reviewer must not have changed the draft, and it must be staged
   * exactly as they reviewed it. With `emergency`, an author may do it alone (Doc 17 exception, audited apart).
   */
  async publish(actor: ConfigActor, expectedRevision: number, body: unknown): Promise<AdminConfigView> {
    const { reason, validDays, emergency } = parsePublishRelease(body);
    await this.db.transaction(async (query) => {
      const draft = await this.draftRow(query, true);
      if (Number(draft.revision) !== expectedRevision) {
        throw new ApiError(HttpStatus.PRECONDITION_FAILED, 'REVISION_MISMATCH', { currentRevision: Number(draft.revision) });
      }
      const current = await this.latest(query);
      const staged = await this.latest(query, 'staging');
      const all = this.blockers(draft, current, staged, actor);
      const bypassed = emergency && all.includes('own_change');
      const reasons = emergency ? all.filter((b) => b !== 'own_change') : all;
      if (reasons.length) throw new ApiError(HttpStatus.CONFLICT, 'PUBLISH_BLOCKED', { reasons });
      const config = normalize(staged!.payload);
      const targets = normalizeTargets(staged!.targets);
      const [r] = await query<{ release: string }>(
        `INSERT INTO app_config_releases
           (schema_version, payload, targets, environment, draft_revision, staged_release, authors, reviewed_by, emergency, published_by, expires_at, reason)
         VALUES ($1, $2, $3, 'production', $4, $5, $6, $7, $8, $9, now() + make_interval(days => $10), $11) RETURNING release`,
        [
          CONFIG_SCHEMA_VERSION,
          JSON.stringify(config),
          JSON.stringify(targets),
          Number(draft.revision),
          staged!.release,
          draft.pending_authors,
          bypassed ? null : actor.userId,
          bypassed,
          actor.userId,
          validDays,
          reason,
        ],
      );
      await query(`UPDATE app_config_draft SET pending_authors = '{}' WHERE id = 1`);
      await writeAudit(query, {
        actor: `user:${actor.userId}`,
        action: bypassed ? 'config.publish_emergency' : 'config.publish',
        targetType: 'config',
        targetId: r.release,
        reason,
        changes: {
          draftRevision: Number(draft.revision),
          stagedRelease: Number(staged!.release),
          previousRelease: current ? Number(current.release) : null,
          fields: this.changes(draft, current),
          validDays,
          ...(bypassed ? { emergency: true, reviewer: 'none' } : {}),
        },
        requestId: actor.requestId,
      });
    });
    this.releaseRows.clear();
    return this.view(actor);
  }

  /**
   * Re-releases an earlier, already reviewed payload as a new release (Doc 17: rollback never edits history).
   * One admin may do this alone, so a bad release can be undone quickly. The draft is left as it is.
   */
  async rollback(actor: ConfigActor, target: number, body: unknown): Promise<AdminConfigView> {
    const { reason, validDays } = parseRelease(body);
    await this.db.transaction(async (query) => {
      // Serialize with publish on the draft row lock, so two releases never race for "latest".
      await this.draftRow(query, true);
      const [old] = await query<ReleaseRow>(`SELECT ${RELEASE_COLUMNS} FROM app_config_releases WHERE release = $1`, [target]);
      if (!old) throw new ApiError(HttpStatus.NOT_FOUND, 'NOT_FOUND');
      if (old.environment !== 'production') throw new ApiError(HttpStatus.CONFLICT, 'PUBLISH_BLOCKED', { reasons: ['not_production'] });
      const current = await this.latest(query);
      if (current && Number(current.release) === target) throw new ApiError(HttpStatus.CONFLICT, 'PUBLISH_BLOCKED', { reasons: ['already_current'] });
      if (old.schema_version !== CONFIG_SCHEMA_VERSION) throw new ApiError(HttpStatus.CONFLICT, 'PUBLISH_BLOCKED', { reasons: ['schema_changed'] });
      const config = normalize(old.payload);
      const [r] = await query<{ release: string }>(
        `INSERT INTO app_config_releases (schema_version, payload, targets, environment, rollback_of, published_by, expires_at, reason)
         VALUES ($1, $2, $3, 'production', $4, $5, now() + make_interval(days => $6), $7) RETURNING release`,
        [CONFIG_SCHEMA_VERSION, JSON.stringify(config), JSON.stringify(normalizeTargets(old.targets)), target, actor.userId, validDays, reason],
      );
      await writeAudit(query, {
        actor: `user:${actor.userId}`,
        action: 'config.rollback',
        targetType: 'config',
        targetId: r.release,
        reason,
        changes: { rollbackOf: target, previousRelease: current ? Number(current.release) : null, validDays },
        requestId: actor.requestId,
      });
    });
    this.releaseRows.clear();
    return this.view(actor);
  }

  /**
   * The newest 50 releases on a channel (releases are few; plenty to find the one that fits), read at most once
   * every few seconds per instance: every app launch asks for its config, and none of them signs in.
   */
  private async recentReleases(channel: Channel): Promise<ReleaseRow[]> {
    const hit = this.releaseRows.get(channel);
    if (hit && Date.now() - hit.at < RELEASES_CACHE_MS) return hit.rows;
    const rows = await this.db.query<ReleaseRow>(`SELECT ${RELEASE_COLUMNS} FROM app_config_releases WHERE environment = $1 ORDER BY release DESC LIMIT 50`, [channel]);
    this.releaseRows.set(channel, { at: Date.now(), rows });
    return rows;
  }

  /**
   * What the apps receive: the newest release on the channel that fits the client's platform and build (or the
   * defaults as release 0) as a compact JWS signed with EdDSA, plus the same fields in the clear for logging and
   * debugging. Apps must act only on the verified JWS.
   */
  async signedCurrent(client: { channel: Channel; platform: Platform | null; build: number | null } = { channel: 'production', platform: null, build: null }): Promise<{ body: { jws: string } & SignedConfig; etag: string }> {
    const rows = await this.recentReleases(client.channel);
    const row = rows.find((r) => fits(normalizeTargets(r.targets), client.platform, client.build)) ?? null;
    const release = row ? Number(row.release) : 0;
    const key = row ? `r${release}` : `d-${client.channel}`;
    const hit = this.cache.get(key);
    const now = Date.now();
    if (hit && now - hit.signedAt < RESIGN_AFTER_MS) return hit;
    const expires = row?.expires_at.getTime() ?? Infinity;
    const doc: SignedConfig = {
      schemaVersion: row?.schema_version ?? CONFIG_SCHEMA_VERSION,
      release,
      environment: client.channel,
      targets: row ? normalizeTargets(row.targets) : DEFAULT_TARGETS,
      publishedAt: row?.published_at.toISOString() ?? null,
      expiresAt: row?.expires_at.toISOString() ?? null,
      issuedAt: new Date(now).toISOString(),
      validUntil: new Date(Math.min(now + SIGNED_COPY_VALID_MS, expires)).toISOString(),
      config: row ? normalize(row.payload) : DEFAULT_CONFIG,
    };
    const jws = await new CompactSign(new TextEncoder().encode(JSON.stringify(doc)))
      .setProtectedHeader({ alg: 'EdDSA', kid: this.signer.keyId, typ: 'tunedeck-config+jws' })
      .sign(this.signer.key);
    const entry = { body: { jws, ...doc }, etag: `"${key}-${this.signer.keyId}-${now.toString(36)}"`, signedAt: now };
    if (this.cache.size > 200) this.cache.clear();
    this.cache.set(key, entry);
    return entry;
  }
}

function pick(p: AppConfigPayload | Targets, path: string): unknown {
  return path.split('.').reduce<unknown>((v, k) => (v as Record<string, unknown>)[k], p);
}

/** Staff configuration screen (Doc 17 /admin/config). Operators can look; only admins change it. */
@Controller('v1/admin/config')
@UseGuards(AuthGuard, StaffGuard)
@RequireRoles('admin', 'operator')
export class AdminConfigController {
  constructor(private readonly configs: AppConfigService) {}

  private send(res: Response, view: AdminConfigView): AdminConfigView {
    res.setHeader('ETag', `"${view.draft.revision}"`);
    res.setHeader('Cache-Control', 'no-store');
    return view;
  }

  @Get()
  async get(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.send(res, await this.configs.view(actorOf(req)));
  }

  @Patch('draft')
  @RequireRoles('admin')
  async update(@Req() req: Request, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    return this.send(res, await this.configs.updateDraft(actorOf(req), parseIfMatch(ifMatch), body));
  }

  /** Releases the draft to the staging channel. If-Match names the draft revision being staged. */
  @Post('stage')
  @HttpCode(HttpStatus.OK)
  @RequireRoles('admin')
  async stage(@Req() req: Request, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const expected = parseIfMatch(ifMatch);
    requireRecentMfa(req);
    return this.send(res, await this.configs.stage(actorOf(req), expected, body));
  }

  /** If-Match names the draft revision the admin reviewed, so a later edit cannot slip into the release. */
  @Post('publish')
  @HttpCode(HttpStatus.OK)
  @RequireRoles('admin')
  async publish(@Req() req: Request, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const expected = parseIfMatch(ifMatch);
    requireRecentMfa(req);
    return this.send(res, await this.configs.publish(actorOf(req), expected, body));
  }

  @Post('releases/:release/rollback')
  @HttpCode(HttpStatus.OK)
  @RequireRoles('admin')
  async rollback(@Req() req: Request, @Param('release') release: string, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const target = parseReleaseId(release);
    requireRecentMfa(req);
    return this.send(res, await this.configs.rollback(actorOf(req), target, body));
  }
}

/** Public, sign-in-free configuration for the apps (Doc 17 GET /config). */
@Controller('v1/config')
export class PublicConfigController {
  constructor(
    private readonly configs: AppConfigService,
    @Inject(APP_CONFIG) private readonly app: AppConfig,
  ) {}

  @Get()
  async get(@Query() query: Record<string, unknown>, @Headers('if-none-match') ifNoneMatch: string | undefined, @Res({ passthrough: true }) res: Response) {
    const { body, etag } = await this.configs.signedCurrent(parseClientQuery(query));
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', this.app.env === 'dev' ? 'no-cache' : 'public, max-age=300');
    if (ifNoneMatch === etag) {
      res.status(HttpStatus.NOT_MODIFIED);
      return undefined;
    }
    return body;
  }
}
