import type { Lang } from './i18n';

/** Display name of a code in the page language, falling back to the code itself when the runtime has no name for it. */
function displayName(type: 'region' | 'language', code: string, lang: Lang): string {
  try {
    const name = new Intl.DisplayNames([lang], { type, fallback: 'none' }).of(code);
    return name || code;
  } catch {
    return code;
  }
}

/** ISO 3166 alpha-2 country code as a name, e.g. TH → ไทย / Thailand. */
export const countryName = (code: string, lang: Lang) => displayName('region', code.toUpperCase(), lang);

/** ISO 639 language code as a name, e.g. th → ภาษาไทย / Thai. Thai names get "ภาษา" so they never read the same as the country. */
export const languageName = (code: string, lang: Lang) => {
  const name = displayName('language', code.toLowerCase(), lang);
  return lang === 'th' && name !== code.toLowerCase() && !name.startsWith('ภาษา') ? `ภาษา${name}` : name;
};
