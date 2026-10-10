import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import type { Lang } from '@/lib/i18n';
import { accountPageLang } from '@/lib/lang';
import { getBff } from '@/lib/runtime';
import { HomeView } from './HomeView';

export const dynamic = 'force-dynamic';

/** /app/home (Tar 2026-10-11): something to play as soon as the page opens: favourites, the curated catalog, and what this browser played last. */
export default async function HomePage() {
  const bff = getBff();
  const jar = await cookies();
  const hadCookie = jar.has(bff.names.session);
  const ctx = await bff.sessionFromCookie(jar.getAll().map((c) => `${c.name}=${c.value}`).join('; '));
  if (!ctx) redirect(hadCookie ? '/login?expired=1' : '/login?returnTo=/app/home');
  const [settings, favorites, catalog] = await Promise.all([
    bff.loadSettings(ctx).catch(() => ({ status: 503 }) as const),
    bff.loadFavorites(ctx).catch(() => ({ status: 503 }) as const),
    bff.loadCatalog().catch(() => ({ status: 503 }) as const),
  ]);
  if (settings === null || favorites === null) redirect('/login?expired=1');
  const lang: Lang = await accountPageLang('view' in settings ? settings.view?.settings.language : undefined);
  return (
    <HomeView
      lang={lang}
      csrfToken={ctx.session.csrfToken}
      favorites={'favorites' in favorites ? (favorites.favorites ?? null) : null}
      stations={'stations' in catalog ? (catalog.stations ?? null) : null}
    />
  );
}
