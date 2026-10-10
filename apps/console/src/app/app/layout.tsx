import { cookies } from 'next/headers';
import type { Lang } from '@/lib/i18n';
import { accountPageLang } from '@/lib/lang';
import { getBff } from '@/lib/runtime';
import { ACCENT_COOKIE, webAccentFrom, webThemeFrom } from '@/lib/web-themes';
import { AppFrame } from './AppFrame';

export const dynamic = 'force-dynamic';

/**
 * The frame every account page shares (Tar 2026-10-11): the layout theme staff chose, the visitor's colour, and one
 * player that keeps playing from page to page. Each page still checks the session itself; without one the frame is
 * bare and the page sends the visitor to sign in.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const bff = getBff();
  const jar = await cookies();
  const ctx = await bff.sessionFromCookie(jar.getAll().map((c) => `${c.name}=${c.value}`).join('; ')).catch(() => null);
  const [theme, settings] = await Promise.all([bff.loadWebTheme().catch(() => null), ctx ? bff.loadSettings(ctx).catch(() => null) : null]);
  const lang: Lang = await accountPageLang(settings && 'view' in settings ? settings.view?.settings.language : undefined);
  return (
    <AppFrame theme={webThemeFrom(theme)} accent={webAccentFrom(jar.get(ACCENT_COOKIE)?.value)} lang={lang} csrfToken={ctx?.session.csrfToken ?? null}>
      {children}
    </AppFrame>
  );
}
