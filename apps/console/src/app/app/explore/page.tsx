import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import type { Lang } from '@/lib/i18n';
import { accountPageLang } from '@/lib/lang';
import { getBff } from '@/lib/runtime';
import { ExploreView } from './ExploreView';

export const dynamic = 'force-dynamic';

/** Community radio on a flat map or a 3D globe (Tar 2026-10-09: both, viewer picks). Stations load in the browser. */
export default async function ExplorePage() {
  const bff = getBff();
  const jar = await cookies();
  const hadCookie = jar.has(bff.names.session);
  const ctx = await bff.sessionFromCookie(jar.getAll().map((c) => `${c.name}=${c.value}`).join('; '));
  if (!ctx) redirect(hadCookie ? '/login?expired=1' : '/login?returnTo=/app/explore');
  const settings = await bff.loadSettings(ctx).catch(() => ({ status: 503 }) as const);
  if (settings === null) redirect('/login?expired=1');
  const lang: Lang = await accountPageLang('view' in settings ? settings.view?.settings.language : undefined);
  return <ExploreView lang={lang} csrfToken={ctx.session.csrfToken} />;
}
