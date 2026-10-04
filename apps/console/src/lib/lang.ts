import { cookies } from 'next/headers';
import type { Lang } from './i18n';

/** Cookie set by the language switch on pages shown before sign-in and on /admin. */
export const LANG_COOKIE = 'td_lang';

/** Thai, the product's default, unless the switch chose English. */
export function langFrom(cookie: string | undefined): Lang {
  return cookie === 'en' ? 'en' : 'th';
}

/** Language for a page without an account setting to go by (sign-in, register, recover, staff pages). */
export async function pageLang(): Promise<Lang> {
  return langFrom((await cookies()).get(LANG_COOKIE)?.value);
}
