import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { MODE_COOKIE, modeFrom, THEME_COOKIE, themeFrom } from '@/lib/admin';
import { translator } from '@/lib/admin-i18n';
import { pageLang } from '@/lib/lang';
import { getBff } from '@/lib/runtime';
import { AdminShell } from './AdminShell';
import { MfaSignInLink } from './MfaSignInLink';
import { fontVariables } from './fonts';
import './admin.css';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'TuneDeck Console' };

/** Every /admin page: signed in with MFA, holds at least one staff role. Each API call checks both again. */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const bff = getBff();
  const jar = await cookies();
  const cookieHeader = jar.getAll().map((c) => `${c.name}=${c.value}`).join('; ');
  const ctx = await bff.sessionFromCookie(cookieHeader);
  if (!ctx) redirect(jar.has(bff.names.session) ? '/login?expired=1&returnTo=/admin/stations' : '/login?returnTo=/admin/stations');

  const staff = await bff.loadStaff(ctx).catch(() => ({ status: 503 }) as const);
  if (staff === null) redirect('/login?expired=1&returnTo=/admin/stations');
  const theme = themeFrom(jar.get(THEME_COOKIE)?.value);
  const lang = await pageLang();
  const t = translator(lang);

  if (!('roles' in staff) || staff.roles.length === 0) {
    const unavailable = !('roles' in staff);
    return (
      <div className={`adm adm-denied t-${theme} ${fontVariables}`}>
        <main>
          <h1>{unavailable ? t('ระบบไม่พร้อมใช้งานชั่วคราว') : t('บัญชีนี้ไม่มีสิทธิ์เข้าหน้าทีมงาน')}</h1>
          <p>{unavailable ? t('ลองโหลดหน้านี้อีกครั้งภายหลัง') : t('ถ้าคุณเป็นทีมงาน ให้ขอสิทธิ์จากผู้ดูแลระบบ')}</p>
          <a href="/app/settings">{t('ไปที่การตั้งค่าของฉัน')}</a>
        </main>
      </div>
    );
  }

  // Doc 17: staff pages need a sign-in with MFA. Keycloak asks for the one-time code, then the person comes back here.
  if (!staff.mfa) {
    return (
      <div className={`adm adm-denied t-${theme} ${fontVariables}`}>
        <main>
          <h1>{t('หน้าทีมงานต้องเข้าสู่ระบบด้วย MFA')}</h1>
          <p>{t('เข้าสู่ระบบอีกครั้งพร้อมรหัสยืนยันตัวตนแบบใช้ครั้งเดียว แล้วระบบจะพากลับมาที่หน้านี้')}</p>
          <MfaSignInLink label={t('เข้าสู่ระบบด้วย MFA')} />
        </main>
      </div>
    );
  }

  // Catalog counts for the header and menu badge; the page still works if this read fails.
  const counts = await bff.loadStationSummary(ctx).catch(() => null);
  const summary = counts?.summary ?? null;

  return (
    <AdminShell
      theme={theme}
      mode={modeFrom(jar.get(MODE_COOKIE)?.value)}
      roles={staff.roles}
      summary={summary}
      csrfToken={ctx.session.csrfToken}
      fontClass={fontVariables}
      lang={lang}
    >
      {children}
    </AdminShell>
  );
}
