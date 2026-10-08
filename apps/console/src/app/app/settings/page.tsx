import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { strings } from '@/lib/i18n';
import { langFromAcceptLanguage } from '@/lib/lang';
import { getBff } from '@/lib/runtime';
import { SettingsForm } from './SettingsForm';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const bff = getBff();
  const jar = await cookies();
  const hadCookie = jar.has(bff.names.session);
  const cookieHeader = jar.getAll().map((c) => `${c.name}=${c.value}`).join('; ');
  const ctx = await bff.sessionFromCookie(cookieHeader);
  if (!ctx) redirect(hadCookie ? '/login?expired=1' : '/login?returnTo=/app/settings');

  const [result, devices] = await Promise.all([
    bff.loadSettings(ctx).catch(() => ({ status: 503 }) as const),
    // Device status is secondary: if it fails, the settings still load and the section says so.
    bff.loadDevices(ctx).catch(() => ({ status: 503 }) as const),
  ]);
  if (result === null || devices === null) redirect('/login?expired=1');

  if (!('view' in result) || !result.view) {
    const t = strings('th');
    return (
      <main className="shell">
        <div className="nav"><span className="brand">{t.appName}</span></div>
        <h1>{t.settingsTitle}</h1>
        <div className="notice error" role="alert">
          <p>{t.loadError}</p>
          <a href="/app/settings">{t.retry}</a>
        </div>
      </main>
    );
  }
  return (
    <SettingsForm
      initial={result.view}
      devices={'view' in devices && devices.view ? devices.view.devices : null}
      csrfToken={ctx.session.csrfToken}
      browserLang={langFromAcceptLanguage((await headers()).get('accept-language'))}
    />
  );
}
