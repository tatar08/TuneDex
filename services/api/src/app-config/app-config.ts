import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, KeyObject } from 'node:crypto';
import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Inject, Injectable, Param, Patch, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { CompactSign } from 'jose';
import { writeAudit } from '../audit/audit';
import { AuthGuard } from '../auth/auth.guard';
import { ApiError } from '../common/api-error';
import { APP_CONFIG, AppConfig } from '../config';
import { Database } from '../db/database';
import { parseIfMatch } from '../settings/settings.schema';
import { RequireRoles, StaffGuard } from '../staff/staff';
import {
  AppConfigPayload,
  applyPatch,
  changedFields,
  CONFIG_SCHEMA_VERSION,
  DEFAULT_CONFIG,
  normalize,
  parseRelease,
  parseReleaseId,
} from './app-config.schema';

/** The signed document the apps receive. `release` 0 means "no release yet: built-in defaults". */
export interface SignedConfig {
  schemaVersion: number;
  release: number;
  publishedAt: string | null;
  expiresAt: string | null;
  config: AppConfigPayload;
}

export interface ReleaseView {
  release: number;
  schemaVersion: number;
  config: AppConfigPayload;
  rollbackOf: number | null;
  draftRevision: number | null;
  publishedAt: string;
  expiresAt: string;
  reason: string;
  /** Whether the person looking published it (names stay out of the console for now). */
  publishedByYou: boolean;
}

export interface AdminConfigView {
  draft: { config: AppConfigPayload; revision: number; updatedAt: string | null; changedSinceRelease: string[] };
  current: ReleaseView | null;
  releases: ReleaseView[];
  /** Why the viewer cannot publish the draft right now; empty when they can. */
  publishBlockers: string[];
  defaults: AppConfigPayload;
  signingKeyId: string;
}

interface DraftRow {
  payload: AppConfigPayload;
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
}
const RELEASE_COLUMNS = 'release, schema_version, payload, draft_revision, rollback_of, published_by, published_at, expires_at, reason';

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
  config: normalize(r.payload),
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
  private cache: { release: number; body: { jws: string } & SignedConfig; etag: string } | null = null;

  constructor(
    private readonly db: Database,
    @Inject(CONFIG_SIGNER) private readonly signer: ConfigSigner,
  ) {}

  private async draftRow(query = this.db.query.bind(this.db), lock = false): Promise<DraftRow> {
    const [row] = await query<DraftRow>(`SELECT payload, revision, updated_at, pending_authors FROM app_config_draft WHERE id = 1${lock ? ' FOR UPDATE' : ''}`);
    if (row) return row;
    // First use: the draft starts from the defaults at revision 0.
    await query(`INSERT INTO app_config_draft (id, payload) VALUES (1, $1) ON CONFLICT (id) DO NOTHING`, [JSON.stringify(DEFAULT_CONFIG)]);
    const [created] = await query<DraftRow>(`SELECT payload, revision, updated_at, pending_authors FROM app_config_draft WHERE id = 1${lock ? ' FOR UPDATE' : ''}`);
    return created;
  }

  private async latest(query = this.db.query.bind(this.db)): Promise<ReleaseRow | null> {
    const [row] = await query<ReleaseRow>(`SELECT ${RELEASE_COLUMNS} FROM app_config_releases ORDER BY release DESC LIMIT 1`);
    return row ?? null;
  }

  private blockers(draft: DraftRow, current: ReleaseRow | null, actor: ConfigActor): string[] {
    const out: string[] = [];
    if (!actor.roles.includes('admin')) out.push('admin_role_required');
    if (draft.pending_authors.includes(actor.userId)) out.push('own_change');
    if (changedFields(normalize(draft.payload), current ? normalize(current.payload) : DEFAULT_CONFIG).length === 0) out.push('no_changes');
    return out;
  }

  async view(actor: ConfigActor): Promise<AdminConfigView> {
    const draft = await this.draftRow();
    const releases = await this.db.query<ReleaseRow>(`SELECT ${RELEASE_COLUMNS} FROM app_config_releases ORDER BY release DESC LIMIT 20`);
    const current = releases[0] ?? null;
    const config = normalize(draft.payload);
    return {
      draft: {
        config,
        revision: Number(draft.revision),
        updatedAt: Number(draft.revision) === 0 ? null : draft.updated_at.toISOString(),
        changedSinceRelease: changedFields(current ? normalize(current.payload) : DEFAULT_CONFIG, config),
      },
      current: current ? releaseView(current, actor.userId) : null,
      releases: releases.map((r) => releaseView(r, actor.userId)),
      publishBlockers: this.blockers(draft, current, actor),
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
      const next = applyPatch(before, body);
      const fields = changedFields(before, next);
      if (fields.length === 0) return;
      const [r] = await query<{ revision: string }>(
        `UPDATE app_config_draft
            SET payload = $1, revision = revision + 1, updated_by = $2, updated_at = now(),
                pending_authors = CASE WHEN $2::uuid = ANY(pending_authors) THEN pending_authors ELSE pending_authors || $2::uuid END
          WHERE id = 1 RETURNING revision`,
        [JSON.stringify(next), actor.userId],
      );
      await writeAudit(query, {
        actor: `user:${actor.userId}`,
        action: 'config.update',
        targetType: 'config',
        targetId: 'draft',
        changes: { fields, revision: Number(r.revision), values: Object.fromEntries(fields.map((f) => [f, pick(next, f)])) },
        requestId: actor.requestId,
      });
    });
    return this.view(actor);
  }

  /** Releases exactly the draft revision the reviewer looked at. The reviewer must not have changed it. */
  async publish(actor: ConfigActor, expectedRevision: number, body: unknown): Promise<AdminConfigView> {
    const { reason, validDays } = parseRelease(body);
    await this.db.transaction(async (query) => {
      const draft = await this.draftRow(query, true);
      if (Number(draft.revision) !== expectedRevision) {
        throw new ApiError(HttpStatus.PRECONDITION_FAILED, 'REVISION_MISMATCH', { currentRevision: Number(draft.revision) });
      }
      const current = await this.latest(query);
      const reasons = this.blockers(draft, current, actor);
      if (reasons.length) throw new ApiError(HttpStatus.CONFLICT, 'PUBLISH_BLOCKED', { reasons });
      const config = normalize(draft.payload);
      const [r] = await query<{ release: string }>(
        `INSERT INTO app_config_releases (schema_version, payload, draft_revision, published_by, expires_at, reason)
         VALUES ($1, $2, $3, $4, now() + make_interval(days => $5), $6) RETURNING release`,
        [CONFIG_SCHEMA_VERSION, JSON.stringify(config), Number(draft.revision), actor.userId, validDays, reason],
      );
      await query(`UPDATE app_config_draft SET pending_authors = '{}' WHERE id = 1`);
      await writeAudit(query, {
        actor: `user:${actor.userId}`,
        action: 'config.publish',
        targetType: 'config',
        targetId: r.release,
        reason,
        changes: {
          draftRevision: Number(draft.revision),
          previousRelease: current ? Number(current.release) : null,
          fields: changedFields(current ? normalize(current.payload) : DEFAULT_CONFIG, config),
          validDays,
        },
        requestId: actor.requestId,
      });
    });
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
      const current = await this.latest(query);
      if (current && Number(current.release) === target) throw new ApiError(HttpStatus.CONFLICT, 'PUBLISH_BLOCKED', { reasons: ['already_current'] });
      if (old.schema_version !== CONFIG_SCHEMA_VERSION) throw new ApiError(HttpStatus.CONFLICT, 'PUBLISH_BLOCKED', { reasons: ['schema_changed'] });
      const config = normalize(old.payload);
      const [r] = await query<{ release: string }>(
        `INSERT INTO app_config_releases (schema_version, payload, rollback_of, published_by, expires_at, reason)
         VALUES ($1, $2, $3, $4, now() + make_interval(days => $5), $6) RETURNING release`,
        [CONFIG_SCHEMA_VERSION, JSON.stringify(config), target, actor.userId, validDays, reason],
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
    return this.view(actor);
  }

  /**
   * What the apps receive: the newest release (or the defaults as release 0) as a compact JWS signed with
   * EdDSA, plus the same fields in the clear for logging and debugging. Apps must act only on the verified JWS.
   */
  async signedCurrent(): Promise<{ body: { jws: string } & SignedConfig; etag: string }> {
    const row = await this.latest();
    const release = row ? Number(row.release) : 0;
    if (this.cache?.release === release) return this.cache;
    const doc: SignedConfig = {
      schemaVersion: row?.schema_version ?? CONFIG_SCHEMA_VERSION,
      release,
      publishedAt: row?.published_at.toISOString() ?? null,
      expiresAt: row?.expires_at.toISOString() ?? null,
      config: row ? normalize(row.payload) : DEFAULT_CONFIG,
    };
    const jws = await new CompactSign(new TextEncoder().encode(JSON.stringify(doc)))
      .setProtectedHeader({ alg: 'EdDSA', kid: this.signer.keyId, typ: 'tunedeck-config+jws' })
      .sign(this.signer.key);
    const etag = `"r${release}-${this.signer.keyId}"`;
    this.cache = { release, body: { jws, ...doc }, etag };
    return this.cache;
  }
}

function pick(p: AppConfigPayload, path: string): unknown {
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

  /** If-Match names the draft revision the admin reviewed, so a later edit cannot slip into the release. */
  @Post('publish')
  @HttpCode(HttpStatus.OK)
  @RequireRoles('admin')
  async publish(@Req() req: Request, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    return this.send(res, await this.configs.publish(actorOf(req), parseIfMatch(ifMatch), body));
  }

  @Post('releases/:release/rollback')
  @HttpCode(HttpStatus.OK)
  @RequireRoles('admin')
  async rollback(@Req() req: Request, @Param('release') release: string, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    return this.send(res, await this.configs.rollback(actorOf(req), parseReleaseId(release), body));
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
  async get(@Headers('if-none-match') ifNoneMatch: string | undefined, @Res({ passthrough: true }) res: Response) {
    const { body, etag } = await this.configs.signedCurrent();
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', this.app.env === 'dev' ? 'no-cache' : 'public, max-age=300');
    if (ifNoneMatch === etag) {
      res.status(HttpStatus.NOT_MODIFIED);
      return undefined;
    }
    return body;
  }
}
