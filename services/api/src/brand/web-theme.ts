import { Body, Controller, Get, HttpCode, HttpStatus, Injectable, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { writeAudit } from '../audit/audit';
import { AuthGuard } from '../auth/auth.guard';
import { ApiError } from '../common/api-error';
import { Database } from '../db/database';
import { RequireRoles, StaffGuard } from '../staff/staff';

/** The layout the web app has until staff choose another: the one it always had. */
export const DEFAULT_WEB_THEME = 'classic';
const THEME = /^[a-z][a-z0-9-]{1,31}$/;

const invalid = (field: string, reason: string) => new ApiError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', { field, reason });

/** Body of a theme change: `{ theme }`, a theme id. The web app owns the list; one it does not know shows the default. */
export function parseWebTheme(body: unknown): string {
  const b = typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  if (!b) throw invalid('body', 'must_be_object');
  for (const k of Object.keys(b)) if (k !== 'theme') throw invalid(k, 'unknown_field');
  if (typeof b.theme !== 'string' || !THEME.test(b.theme)) throw invalid('theme', 'must_be_theme_id');
  return b.theme;
}

/**
 * The web app's layout theme (Tar 2026-10-11): staff choose one for every visitor on the admin settings page;
 * visitors themselves only choose a colour, which stays in their browser.
 */
@Injectable()
export class WebThemeService {
  constructor(private readonly db: Database) {}

  async current(): Promise<{ theme: string; updatedBy: string | null; updatedAt: string | null }> {
    const [row] = await this.db.query<{ value: string; subject: string | null; updated_at: Date }>(
      `SELECT s.value, u.oidc_subject AS subject, s.updated_at FROM site_settings s LEFT JOIN users u ON u.id = s.updated_by WHERE s.key = 'web_theme'`,
    );
    return row ? { theme: row.value, updatedBy: row.subject, updatedAt: row.updated_at.toISOString() } : { theme: DEFAULT_WEB_THEME, updatedBy: null, updatedAt: null };
  }

  async set(actor: { userId: string; requestId: string }, theme: string): Promise<{ theme: string; updatedBy: string | null; updatedAt: string | null }> {
    await this.db.transaction(async (query) => {
      const [before] = await query<{ value: string }>(`SELECT value FROM site_settings WHERE key = 'web_theme' FOR UPDATE`);
      await query(
        `INSERT INTO site_settings (key, value, updated_by) VALUES ('web_theme', $1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [theme, actor.userId],
      );
      await writeAudit(query, {
        actor: `user:${actor.userId}`,
        action: 'brand.web_theme.set',
        targetType: 'brand',
        targetId: 'web_theme',
        changes: { from: before?.value ?? DEFAULT_WEB_THEME, to: theme },
        requestId: actor.requestId,
      });
    });
    return this.current();
  }
}

/** Public, sign-in-free: which layout the web app shows. */
@Controller('v1/brand/web-theme')
export class WebThemeController {
  constructor(private readonly themes: WebThemeService) {}

  @Get()
  async get(@Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'public, max-age=60');
    return { theme: (await this.themes.current()).theme };
  }
}

/** Admins choose the web app's layout for everyone. */
@Controller('v1/admin/brand/web-theme')
@UseGuards(AuthGuard, StaffGuard)
@RequireRoles('admin')
export class AdminWebThemeController {
  constructor(private readonly themes: WebThemeService) {}

  @Get()
  async status(@Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    return this.themes.current();
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  async set(@Req() req: Request, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    return this.themes.set({ userId: req.actor!.userId, requestId: req.requestId }, parseWebTheme(body));
  }
}
