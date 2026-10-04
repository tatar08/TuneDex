import { EN_CORE } from './admin-en/core';
import { EN_OPS } from './admin-en/ops';
import { EN_PEOPLE } from './admin-en/people';
import { EN_STATIONS } from './admin-en/stations';
import type { Lang } from './i18n';

/**
 * Doc 17 "Thai/English labels on every page" for the staff console. The Thai text stays in the code as the key
 * (it is the product's default language); English comes from these tables. Placeholders `{0}`, `{1}` … take the
 * values passed to t(), so a sentence is translated whole rather than glued from pieces.
 */
export const ADMIN_EN: Record<string, string> = { ...EN_CORE, ...EN_STATIONS, ...EN_OPS, ...EN_PEOPLE };

/** Translates by Thai key; `lang` lets date and number formatters follow the same choice. */
export type Translate = ((thai: string, ...values: Array<string | number>) => string) & { readonly lang: Lang };

export function translator(lang: Lang): Translate {
  const t = (thai: string, ...values: Array<string | number>) => {
    const text = lang === 'en' ? (ADMIN_EN[thai] ?? thai) : thai;
    return values.length ? text.replace(/\{(\d+)\}/g, (m, i) => (values[Number(i)] === undefined ? m : String(values[Number(i)]))) : text;
  };
  return Object.assign(t, { lang });
}
