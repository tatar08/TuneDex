import { cookies, headers } from 'next/headers';
import { accountLang, type Lang } from './i18n';

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

/** The browser's choice between the two languages: English only when Accept-Language ranks it above Thai. */
export function langFromAcceptLanguage(header: string | null | undefined): Lang {
  const ranked = (header ?? '')
    .split(',')
    .map((part, i) => {
      const [tag, ...params] = part.trim().toLowerCase().split(';');
      const q = Number(params.find((p) => p.trim().startsWith('q='))?.trim().slice(2) ?? 1);
      return { base: tag.split('-')[0], q: Number.isFinite(q) ? q : 0, i };
    })
    .filter((x) => (x.base === 'th' || x.base === 'en') && x.q > 0)
    .sort((a, b) => b.q - a.q || a.i - b.i);
  return ranked[0]?.base === 'en' ? 'en' : 'th';
}

/** Page language for an account page: the account setting, with 'system' following the browser. */
export async function accountPageLang(setting: string | undefined): Promise<Lang> {
  return accountLang(setting, langFromAcceptLanguage((await headers()).get('accept-language')));
}
