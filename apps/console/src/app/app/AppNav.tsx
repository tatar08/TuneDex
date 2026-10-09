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

/** Top bar shared by the account pages. */
export function AppNav({ lang, current, csrfToken }: { lang: Lang | string; current: (typeof LINKS)[number]['href']; csrfToken: string }) {
  const t = strings(lang);
  return (
    <div className="nav">
      <span className="brand">{t.appName}</span>
      {LINKS.map((l) => (
        <a key={l.href} href={l.href} aria-current={l.href === current ? 'page' : undefined}>
          {t[l.key]}
        </a>
      ))}
      <form method="post" action="/auth/logout">
        <input type="hidden" name="csrf" value={csrfToken} />
        <button type="submit">{t.signOut}</button>
      </form>
    </div>
  );
}
