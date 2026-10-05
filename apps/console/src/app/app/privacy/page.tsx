import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import type { Lang } from '@/lib/i18n';
import { getBff } from '@/lib/runtime';
import { PrivacyView } from './PrivacyView';

export const dynamic = 'force-dynamic';

/** Doc 17 /app/privacy: the account's own diagnostic reports, a data export and account deletion. */
export default async function PrivacyPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const bff = getBff();
  const jar = await cookies();
  const hadCookie = jar.has(bff.names.session);
  const ctx = await bff.sessionFromCookie(jar.getAll().map((c) => `${c.name}=${c.value}`).join('; '));
  if (!ctx) redirect(hadCookie ? '/login?expired=1' : '/login?returnTo=/app/privacy');

  const [settings, diagnostics] = await Promise.all([
    bff.loadSettings(ctx).catch(() => ({ status: 503 }) as const),
    bff.loadDiagnostics(ctx).catch(() => ({ status: 503 }) as const),
  ]);
  if (settings === null || diagnostics === null) redirect('/login?expired=1');
  const lang: Lang = 'view' in settings && settings.view?.settings.language === 'en' ? 'en' : 'th';
  const sp = await searchParams;
  return (
    <PrivacyView
      lang={lang}
      csrfToken={ctx.session.csrfToken}
      view={'view' in diagnostics && diagnostics.view ? diagnostics.view : null}
      // Back from a re-authentication started by "delete this account".
      pendingDelete={sp.delete === '1'}
      // Back from a re-authentication started by "prepare my data".
      pendingExport={sp.export === '1'}
      reauthFailed={sp.reauth === 'failed'}
    />
  );
}
