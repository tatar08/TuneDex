import { LANG_COOKIE } from '@/lib/lang';

export const dynamic = 'force-dynamic';

/** Pages this switch may come back to: the ones without an account language to follow. */
const BACK = /^\/(login|register|recover|admin)(\/[A-Za-z0-9/_-]*)?$/;

/** GET /lang?to=en&returnTo=/login — remembers the language for a year and goes back. */
export function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const to = params.get('to') === 'en' ? 'en' : 'th';
  const back = params.get('returnTo') ?? '';
  const location = BACK.test(back) ? back : '/login';
  const secure = new URL(req.url).protocol === 'https:' ? '; Secure' : '';
  return new Response(null, {
    status: 303,
    headers: { location, 'set-cookie': `${LANG_COOKIE}=${to}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly${secure}`, 'cache-control': 'no-store' },
  });
}
