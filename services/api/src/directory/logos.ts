import { createHash } from 'node:crypto';
import { Body, Controller, Get, HttpCode, HttpStatus, Injectable, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { writeAudit } from '../audit/audit';
import { AuthGuard } from '../auth/auth.guard';
import { ApiError } from '../common/api-error';
import { Database } from '../db/database';
import { RequireRoles, StaffGuard } from '../staff/staff';

/** The largest logo staff can upload, and the JSON body that carries it as base64. */
export const LOGO_MAX_BYTES = 256 * 1024;
export const LOGO_BODY_BYTES = 360 * 1024;
const KEY = /^(default|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

export type LogoType = 'image/png' | 'image/jpeg' | 'image/webp';

/** Which logos staff have uploaded: `default` is our own logo's version, `stations` maps a station id to its version. */
export interface LogoIndex {
  default: string | null;
  stations: Map<string, string>;
}

export interface LogoInfo {
  key: string;
  version: string;
  contentType: LogoType;
  bytes: number;
  updatedBy: string | null;
  updatedAt: string;
}

const invalid = (field: string, reason: string, extra: Record<string, unknown> = {}) =>
  new ApiError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', { field, reason, ...extra });

/** PNG, JPEG or WebP by the file's first bytes; what the upload calls itself is never trusted. SVG is refused (it can carry script). */
export function sniffImage(b: Buffer): LogoType | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/** The widest and tallest logo accepted; the console sends 256 px, so this only stops an image made to exhaust a decoder. */
export const LOGO_MAX_PIXELS = 1024;

/** Width and height read from the file's own header, or null when it is not a complete, plain image header. */
export function imageSize(b: Buffer, type: LogoType): { width: number; height: number } | null {
  if (type === 'image/png') {
    return b.length >= 24 && b.toString('latin1', 12, 16) === 'IHDR' ? { width: b.readUInt32BE(16), height: b.readUInt32BE(20) } : null;
  }
  if (type === 'image/webp') {
    if (b.length < 30) return null;
    const chunk = b.toString('latin1', 12, 16);
    if (chunk === 'VP8X') return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
    if (chunk === 'VP8L') return b[20] === 0x2f ? { width: 1 + (b.readUInt16LE(21) & 0x3fff), height: 1 + ((b.readUInt32LE(21) >>> 14) & 0x3fff) } : null;
    if (chunk === 'VP8 ') return b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a ? { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff } : null;
    return null;
  }
  // JPEG: walk the segments to the first start-of-frame, which holds the size.
  for (let i = 2; i + 9 < b.length; ) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1];
    if (marker === 0xff) {
      i += 1;
      continue;
    }
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      i += 2;
      continue;
    }
    i += 2 + b.readUInt16BE(i + 2);
  }
  return null;
}

/** `default` or a Radio Browser station id, lower case. */
export function parseLogoKey(raw: string): string {
  const key = raw.toLowerCase();
  if (!KEY.test(key)) throw invalid('key', 'must_be_uuid_or_default');
  return key;
}

/** Body of an upload: `{ image }`, the file as base64. */
export function parseLogo(body: unknown): { contentType: LogoType; image: Buffer } {
  const b = typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  if (!b) throw invalid('body', 'must_be_object');
  for (const k of Object.keys(b)) if (k !== 'image') throw invalid(k, 'unknown_field');
  if (typeof b.image !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(b.image) || b.image.length % 4 !== 0) throw invalid('image', 'must_be_base64');
  const image = Buffer.from(b.image, 'base64');
  if (image.length > LOGO_MAX_BYTES) throw invalid('image', 'too_large', { maxBytes: LOGO_MAX_BYTES });
  const contentType = sniffImage(image);
  if (!contentType) throw invalid('image', 'must_be_png_jpeg_or_webp');
  const size = imageSize(image, contentType);
  if (!size || size.width < 1 || size.height < 1) throw invalid('image', 'must_be_png_jpeg_or_webp');
  if (size.width > LOGO_MAX_PIXELS || size.height > LOGO_MAX_PIXELS) throw invalid('image', 'dimensions_too_large', { maxPixels: LOGO_MAX_PIXELS });
  return { contentType, image };
}

/**
 * Logos staff upload for community stations (Tar 2026-10-10). A station's own logo comes from Radio Browser as a
 * link to someone else's server; an uploaded one replaces it, and `default` is our own logo for stations without.
 */
@Injectable()
export class LogoService {
  constructor(private readonly db: Database) {}

  async index(): Promise<LogoIndex> {
    const rows = await this.db.query<{ key: string; version: string }>('SELECT key, version FROM directory_logos');
    return {
      default: rows.find((r) => r.key === 'default')?.version ?? null,
      stations: new Map(rows.filter((r) => r.key !== 'default').map((r) => [r.key, r.version])),
    };
  }

  async image(key: string): Promise<{ contentType: LogoType; image: Buffer; version: string } | null> {
    const [row] = await this.db.query<{ content_type: LogoType; image: Buffer; version: string }>('SELECT content_type, image, version FROM directory_logos WHERE key = $1', [key]);
    return row ? { contentType: row.content_type, image: row.image, version: row.version } : null;
  }

  /** Our own logo as staff see it on the settings page, and how many stations have an uploaded one. */
  async summary(): Promise<{ default: LogoInfo | null; stations: number }> {
    const rows = await this.db.query<{ key: string; version: string; content_type: LogoType; bytes: number; subject: string | null; updated_at: Date }>(
      `SELECT l.key, l.version, l.content_type, octet_length(l.image) AS bytes, u.oidc_subject AS subject, l.updated_at
         FROM directory_logos l LEFT JOIN users u ON u.id = l.updated_by WHERE l.key = 'default'`,
    );
    const [{ n }] = await this.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM directory_logos WHERE key <> 'default'`);
    const d = rows[0];
    return { default: d ? { key: d.key, version: d.version, contentType: d.content_type, bytes: d.bytes, updatedBy: d.subject, updatedAt: d.updated_at.toISOString() } : null, stations: n };
  }

  async set(actor: { userId: string; requestId: string }, key: string, logo: { contentType: LogoType; image: Buffer }): Promise<LogoInfo> {
    const version = createHash('sha256').update(logo.image).digest('hex').slice(0, 16);
    return this.db.transaction(async (query) => {
      const [row] = await query<{ updated_at: Date }>(
        `INSERT INTO directory_logos (key, content_type, image, version, updated_by) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (key) DO UPDATE SET content_type = EXCLUDED.content_type, image = EXCLUDED.image, version = EXCLUDED.version,
           updated_by = EXCLUDED.updated_by, updated_at = now()
         RETURNING updated_at`,
        [key, logo.contentType, logo.image, version, actor.userId],
      );
      await writeAudit(query, {
        actor: `user:${actor.userId}`,
        action: 'directory.logo.set',
        targetType: 'directory_logo',
        targetId: key,
        changes: { contentType: logo.contentType, bytes: logo.image.length, version },
        requestId: actor.requestId,
      });
      const [subject] = await query<{ oidc_subject: string }>('SELECT oidc_subject FROM users WHERE id = $1', [actor.userId]);
      return { key, version, contentType: logo.contentType, bytes: logo.image.length, updatedBy: subject?.oidc_subject ?? null, updatedAt: row.updated_at.toISOString() };
    });
  }

  async remove(actor: { userId: string; requestId: string }, key: string): Promise<void> {
    await this.db.transaction(async (query) => {
      const [row] = await query<{ version: string }>('DELETE FROM directory_logos WHERE key = $1 RETURNING version', [key]);
      if (!row) throw new ApiError(HttpStatus.NOT_FOUND, 'NOT_FOUND');
      await writeAudit(query, {
        actor: `user:${actor.userId}`,
        action: 'directory.logo.remove',
        targetType: 'directory_logo',
        targetId: key,
        changes: { version: row.version },
        requestId: actor.requestId,
      });
    });
  }
}

/** Public, sign-in-free: an uploaded logo's bytes. Station answers say which stations have one (`customLogoVersion`). */
@Controller('v1/directory/radio/logos')
export class DirectoryLogoController {
  constructor(private readonly logos: LogoService) {}

  /** `key` is a station id or `default`; `v` (the version from a station answer) makes the answer cacheable for good. */
  @Get(':key')
  async get(@Param('key') rawKey: string, @Query() q: Record<string, unknown>, @Req() req: Request, @Res() res: Response): Promise<void> {
    for (const k of Object.keys(q)) if (k !== 'v') throw invalid(k, 'unknown_field');
    const logo = await this.logos.image(parseLogoKey(rawKey));
    if (!logo) throw new ApiError(HttpStatus.NOT_FOUND, 'NOT_FOUND');
    const etag = `"${logo.version}"`;
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', q.v === logo.version ? 'public, max-age=31536000, immutable' : 'public, max-age=300');
    // The bytes are an upload: never guessed into another type, never run, and usable as an image from any site.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    if (req.headers['if-none-match'] === etag) {
      res.status(HttpStatus.NOT_MODIFIED).end();
      return;
    }
    res.status(HttpStatus.OK).type(logo.contentType).send(logo.image);
  }
}

/** Staff upload a station's logo or our own, or take one away again (Tar 2026-10-10). */
@Controller('v1/admin/directory/logos')
@UseGuards(AuthGuard, StaffGuard)
@RequireRoles('catalog_editor', 'admin')
export class AdminDirectoryLogoController {
  constructor(private readonly logos: LogoService) {}

  @Get()
  async summary(@Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    return this.logos.summary();
  }

  @Post(':key')
  @HttpCode(HttpStatus.OK)
  async set(@Req() req: Request, @Param('key') key: string, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    return this.logos.set({ userId: req.actor!.userId, requestId: req.requestId }, parseLogoKey(key), parseLogo(body));
  }

  @Post(':key/remove')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Req() req: Request, @Param('key') key: string) {
    await this.logos.remove({ userId: req.actor!.userId, requestId: req.requestId }, parseLogoKey(key));
  }
}
