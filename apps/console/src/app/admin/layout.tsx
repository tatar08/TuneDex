import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { THEME_COOKIE, themeFrom } from '@/lib/admin';
import { getBff } from '@/lib/runtime';
import { AdminShell } from './AdminShell';
import { fontVariables } from './fonts';
import './admin.css';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'TuneDeck Console' };

/** Every /admin page: signed in, holds at least one staff role. Each API call checks the role again. */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const bff = getBff();
  const jar = await cookies();
  const cookieHeader = jar.getAll().map((c) => `${c.name}=${c.value}`).join('; ');
  const ctx = await bff.sessionFromCookie(cookieHeader);
  if (!ctx) redirect(jar.has(bff.names.session) ? '/login?expired=1&returnTo=/admin/stations' : '/login?returnTo=/admin/stations');

  const staff = await bff.loadStaff(ctx).catch(() => ({ status: 503 }) as const);
  if (staff === null) redirect('/login?expired=1&returnTo=/admin/stations');
  const theme = themeFrom(jar.get(THEME_COOKIE)?.value);

  if (!('roles' in staff) || staff.roles.length === 0) {
    const unavailable = !('roles' in staff);
    return (
      <div className={`adm adm-denied t-${theme} ${fontVariables}`}>
        <main>
          <h1>{unavailable ? 'ระบบไม่พร้อมใช้งานชั่วคราว' : 'บัญชีนี้ไม่มีสิทธิ์เข้าหน้าทีมงาน'}</h1>
          <p>{unavailable ? 'ลองโหลดหน้านี้อีกครั้งภายหลัง' : 'ถ้าคุณเป็นทีมงาน ให้ขอสิทธิ์จากผู้ดูแลระบบ'}</p>
          <a href="/app/settings">ไปที่การตั้งค่าของฉัน</a>
        </main>
      </div>
    );
  }

  return (
    <AdminShell theme={theme} roles={staff.roles} csrfToken={ctx.session.csrfToken} fontClass={fontVariables}>
      {children}
    </AdminShell>
  );
}
