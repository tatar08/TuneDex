import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import type { Lang } from '@/lib/i18n';
import { strings } from '@/lib/i18n';
import { getBff } from '@/lib/runtime';
import { AppNav } from '../AppNav';

export const dynamic = 'force-dynamic';

/** Doc 17 /app/overview: the account's devices with their last successful sync, and the service status. */
export default async function OverviewPage() {
  const bff = getBff();
  const jar = await cookies();
  const hadCookie = jar.has(bff.names.session);
  const ctx = await bff.sessionFromCookie(jar.getAll().map((c) => `${c.name}=${c.value}`).join('; '));
  if (!ctx) redirect(hadCookie ? '/login?expired=1' : '/login?returnTo=/app/overview');

  const [ready, settings, devices, favorites, entitlements] = await Promise.all([
    bff.serviceReady(),
    bff.loadSettings(ctx).catch(() => ({ status: 503 }) as const),
    bff.loadDevices(ctx).catch(() => ({ status: 503 }) as const),
    bff.loadFavorites(ctx).catch(() => ({ status: 503 }) as const),
    bff.loadEntitlements(ctx).catch(() => ({ status: 503 }) as const),
  ]);
  if (settings === null || devices === null || favorites === null || entitlements === null) redirect('/login?expired=1');
  const lang: Lang = 'view' in settings && settings.view?.settings.language === 'en' ? 'en' : 'th';
  const t = strings(lang);
  // Times read in Thailand time whatever the server's zone, like the other account pages.
  const fmt = new Intl.DateTimeFormat(lang === 'en' ? 'en-GB' : 'th-TH', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Bangkok' });
  const list = 'view' in devices && devices.view ? devices.view.devices.filter((d) => !d.revokedAt) : null;
  const favs = 'favorites' in favorites ? favorites.favorites : undefined;
  const pro = 'pro' in entitlements ? entitlements.pro : undefined;
  const rev = 'view' in settings && settings.view ? settings.view.revision : null;

  return (
    <main className="shell" lang={lang}>
      <AppNav lang={lang} current="/app/overview" csrfToken={ctx.session.csrfToken} />
      <h1>{t.overviewTitle}</h1>
      <p className="lede">{t.overviewLede}</p>

      <section className="device" aria-labelledby="service-title">
        <h2 id="service-title">{t.serviceTitle}</h2>
        {ready ? (
          <p className="status" data-testid="service">
            <span className="chip ok">{t.serviceOk(fmt.format(new Date()))}</span>
          </p>
        ) : (
          <div role="alert" className="notice error" data-testid="service">
            <p>{t.serviceDown}</p>
          </div>
        )}
        <p className="status">
          {favs ? t.overviewFavorites(favs.length) : `${t.radioFavorites}: ${t.overviewUnknown}`} · {rev === null ? `${t.navSettings}: ${t.overviewUnknown}` : t.overviewSettings(rev)}
        </p>
      </section>

      <section className="device" aria-labelledby="pro-title">
        <h2 id="pro-title">{t.proTitle}</h2>
        {pro ? (
          <ul className="devices">
            {(['apple', 'google'] as const).map((store) => (
              <li key={store} data-testid="pro-store">
                <span className="device-name">{t.proStore(store)}</span>
                <span className="status">{t[`pro.${pro[store]}`]}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="status">{t.overviewUnknown}</p>
        )}
        <p className="status">{t.proNote}</p>
      </section>

      <section className="device" aria-labelledby="ov-devices">
        <h2 id="ov-devices">{t.overviewDevices}</h2>
        {list === null && <p className="status">{t.devicesListError}</p>}
        {list !== null && list.length === 0 && <p className="status">{t.devicesEmpty}</p>}
        {list && list.length > 0 && (
          <ul className="devices">
            {list.map((d) => (
              <li key={d.id} data-testid="overview-device">
                <span className="device-name">{t.deviceName(d.platform, d.osMajor)}</span>
                <span className="status">
                  {d.lastSyncedAt ? t.syncedAt(fmt.format(new Date(d.lastSyncedAt))) : t.neverSynced} · {t.deviceSeen(d.appBuild, fmt.format(new Date(d.lastSeenAt)))}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p>
          <a href="/app/devices">{t.devicesManage}</a>
        </p>
      </section>
    </main>
  );
}
