import 'server-only';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { THEME_COOKIE, themeFrom } from '@/lib/admin';
import { getBff } from '@/lib/runtime';

/** Session and theme for a staff page; the layout has already checked that the account is staff. */
export async function staffPage(returnTo: string) {
  const bff = getBff();
  const jar = await cookies();
  const ctx = await bff.sessionFromCookie(jar.getAll().map((c) => `${c.name}=${c.value}`).join('; '));
  if (!ctx) redirect(`/login?expired=1&returnTo=${encodeURIComponent(returnTo)}`);
  return { bff, ctx, theme: themeFrom(jar.get(THEME_COOKIE)?.value) };
}

export function LoadError({ status }: { status: number }) {
  return (
    <div className="adm-alert" role="alert">
      {status === 403 ? 'บัญชีนี้ไม่มีสิทธิ์ดูรายการสถานี' : status === 404 ? 'ไม่พบสถานีนี้' : 'โหลดข้อมูลไม่ได้ในขณะนี้ ลองโหลดหน้าใหม่'}
    </div>
  );
}
