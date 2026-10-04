import { cookies, headers } from 'next/headers';
import type { Lang } from './i18n';

/** Cookie set by the language switch on pages shown before sign-in and on /admin. */
export const LANG_COOKIE = 'td_lang';

/** Thai unless the switch chose English or the browser prefers English over Thai. */
export function langFrom(cookie: string | undefined, acceptLanguage: string | null): Lang {
  if (cookie === 'th' || cookie === 'en') return cookie;
  const first = (acceptLanguage ?? '').split(',')[0]?.trim().toLowerCase() ?? '';
  return first.startsWith('en') ? 'en' : 'th';
}

/** Language for a page without an account setting to go by (sign-in, register, recover, staff pages). */
export async function pageLang(): Promise<Lang> {
  const jar = await cookies();
  return langFrom(jar.get(LANG_COOKIE)?.value, (await headers()).get('accept-language'));
}
