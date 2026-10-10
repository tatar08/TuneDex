import type { Lang } from '@/lib/i18n';
import { strings } from '@/lib/i18n';

const LINKS = [
  { href: '/app/overview', key: 'navOverview' },
  { href: '/app/radio', key: 'navRadio' },
  { href: '/app/explore', key: 'navExplore' },
  { href: '/app/settings', key: 'navSettings' },
  { href: '/app/devices', key: 'navDevices' },
  { href: '/app/privacy', key: 'navPrivacy' },
] as const;
type Href = (typeof LINKS)[number]['href'];

/** The first four links sit in the phone's bottom bar; the rest go under "More". */
const TABS = 4;
const ICONS: Record<Href, string> = {
  '/app/overview': 'M4 11l8-7 8 7v8a1 1 0 0 1-1 1h-4v-6h-6v6H5a1 1 0 0 1-1-1z',
  '/app/radio': 'M4 10a8 8 0 0 1 16 0M7.5 12a4.5 4.5 0 0 1 9 0M12 14v6',
  '/app/explore': 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18',
  '/app/settings': 'M4 7h10M18 7h2M4 17h4M12 17h8M16 5v4M10 15v4',
  '/app/devices': 'M8 3h8a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM11 18h2',
  '/app/privacy': 'M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6z',
};
const Icon = ({ d }: { d: string }) => (
  <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d={d} />
  </svg>
);

/** Top bar shared by the account pages; on a phone the links move to a bottom tab bar within thumb reach. */
export function AppNav({ lang, current, csrfToken }: { lang: Lang | string; current: Href; csrfToken: string }) {
  const t = strings(lang);
  const logout = (
    <form method="post" action="/auth/logout">
      <input type="hidden" name="csrf" value={csrfToken} />
      <button type="submit">{t.signOut}</button>
    </form>
  );
  const more = LINKS.slice(TABS);
  return (
    <>
      <div className="nav">
        <span className="brand">{t.appName}</span>
        {LINKS.map((l) => (
          <a key={l.href} href={l.href} aria-current={l.href === current ? 'page' : undefined}>
            {t[l.key]}
          </a>
        ))}
        {logout}
      </div>
      <nav className="tabbar" aria-label={t.navMenu}>
        {LINKS.slice(0, TABS).map((l) => (
          <a key={l.href} href={l.href} aria-current={l.href === current ? 'page' : undefined}>
            <Icon d={ICONS[l.href]} />
            <span>{t[l.key]}</span>
          </a>
        ))}
        <details className="tabbar-more">
          <summary aria-current={more.some((l) => l.href === current) ? 'page' : undefined}>
            <Icon d="M5 12h.01M12 12h.01M19 12h.01" />
            <span>{t.navMore}</span>
          </summary>
          <div className="tabbar-menu">
            {more.map((l) => (
              <a key={l.href} href={l.href} aria-current={l.href === current ? 'page' : undefined}>
                <Icon d={ICONS[l.href]} />
                {t[l.key]}
              </a>
            ))}
            {logout}
          </div>
        </details>
      </nav>
    </>
  );
}
