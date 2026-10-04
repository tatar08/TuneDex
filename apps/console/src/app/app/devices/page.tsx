import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import type { Lang } from '@/lib/i18n';
import { getBff } from '@/lib/runtime';
import { DevicesView } from './DevicesView';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Doc 17 /app/devices: the account's phones, with a re-authenticated sign-out per device. */
export default async function DevicesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const bff = getBff();
  const jar = await cookies();
  const hadCookie = jar.has(bff.names.session);
  const ctx = await bff.sessionFromCookie(jar.getAll().map((c) => `${c.name}=${c.value}`).join('; '));
  if (!ctx) redirect(hadCookie ? '/login?expired=1' : '/login?returnTo=/app/devices');

  const [settings, devices, me] = await Promise.all([
    bff.loadSettings(ctx).catch(() => ({ status: 503 }) as const),
    bff.loadDevices(ctx).catch(() => ({ status: 503 }) as const),
    bff.loadMe(ctx).catch(() => ({ status: 503 }) as const),
  ]);
  if (settings === null || devices === null || me === null) redirect('/login?expired=1');
  const lang: Lang = 'view' in settings && settings.view?.settings.language === 'en' ? 'en' : 'th';
  const sp = await searchParams;
  // After a re-authentication the user lands back here with the device they were signing out still chosen.
  const revoke = typeof sp.revoke === 'string' && UUID.test(sp.revoke) ? sp.revoke.toLowerCase() : null;
  return (
    <DevicesView
      lang={lang}
      csrfToken={ctx.session.csrfToken}
      devices={'view' in devices && devices.view ? devices.view.devices : null}
      accountId={'userId' in me ? (me.userId ?? null) : null}
      pendingRevoke={revoke}
      reauthFailed={sp.reauth === 'failed'}
    />
  );
}
