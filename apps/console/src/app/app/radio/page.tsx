import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import type { Lang } from '@/lib/i18n';
import { getBff } from '@/lib/runtime';
import { RadioView } from './RadioView';

export const dynamic = 'force-dynamic';

/** Doc 17 /app/radio: the approved catalog and the account's own favorites and their order. No playback here. */
export default async function RadioPage() {
  const bff = getBff();
  const jar = await cookies();
  const hadCookie = jar.has(bff.names.session);
  const ctx = await bff.sessionFromCookie(jar.getAll().map((c) => `${c.name}=${c.value}`).join('; '));
  if (!ctx) redirect(hadCookie ? '/login?expired=1' : '/login?returnTo=/app/radio');

  const [settings, favorites, catalog] = await Promise.all([
    bff.loadSettings(ctx).catch(() => ({ status: 503 }) as const),
    bff.loadFavorites(ctx).catch(() => ({ status: 503 }) as const),
    bff.loadCatalog().catch(() => ({ status: 503 }) as const),
  ]);
  if (settings === null || favorites === null) redirect('/login?expired=1');
  const lang: Lang = 'view' in settings && settings.view?.settings.language === 'en' ? 'en' : 'th';
  return (
    <RadioView
      lang={lang}
      csrfToken={ctx.session.csrfToken}
      favorites={'favorites' in favorites ? (favorites.favorites ?? null) : null}
      stations={'stations' in catalog ? (catalog.stations ?? null) : null}
    />
  );
}
