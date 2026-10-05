import type { Lang } from '@/lib/i18n';
import { strings } from '@/lib/i18n';

/** Link to the other language, coming back to `path`. */
export function LangSwitch({ lang, path }: { lang: Lang; path: string }) {
  return (
    <a className="lang-switch" href={`/lang?to=${lang === 'th' ? 'en' : 'th'}&returnTo=${encodeURIComponent(path)}`} lang={lang === 'th' ? 'en' : 'th'}>
      {strings(lang).switchLang}
    </a>
  );
}
