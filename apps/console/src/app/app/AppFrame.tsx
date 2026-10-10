'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { createContext, useContext, useState } from 'react';
import { Lang, strings } from '@/lib/i18n';
import { ACCENT_COOKIE, WebAccentId, WebThemeId } from '@/lib/web-themes';
import { Icon, ICONS } from './AppNav';
import { PlayerProvider } from './player/Player';

const AccentCtx = createContext<{ accent: WebAccentId; setAccent: (a: WebAccentId) => void }>({ accent: 'default', setAccent: () => undefined });
/** The visitor's colour and how to change it; kept a year in a cookie of this browser, so the server draws it at once. */
export const useAccent = () => useContext(AccentCtx);

const HOME_ICON = 'M4 11l8-7 8 7v8a1 1 0 0 1-1 1h-4v-6h-6v6H5a1 1 0 0 1-1-1z';
const ACCOUNT_ICON = 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 20a8 8 0 0 1 16 0';

/** Side menu of the themes that have one, on a wide screen: what to listen to on top, the account below. */
function SideNav({ lang, csrfToken }: { lang: Lang; csrfToken: string }) {
  const t = strings(lang);
  const path = usePathname();
  const link = (href: string, icon: string, text: string) => (
    <Link key={href} href={href} prefetch={false} aria-current={path === href ? 'page' : undefined}>
      <Icon d={icon} />
      <span>{text}</span>
    </Link>
  );
  return (
    <nav className="side-nav" aria-label={t.navMenu}>
      <Link href="/app/home" prefetch={false} className="brand">
        {t.appName}
      </Link>
      {link('/app/home', HOME_ICON, t.navHome)}
      {link('/app/radio', ICONS['/app/radio'], t.navRadio)}
      {link('/app/explore', ICONS['/app/explore'], t.navExplore)}
      <span className="side-group">{t.navAccount}</span>
      {link('/app/overview', ACCOUNT_ICON, t.navOverview)}
      {link('/app/settings', ICONS['/app/settings'], t.navSettings)}
      {link('/app/devices', ICONS['/app/devices'], t.navDevices)}
      {link('/app/privacy', ICONS['/app/privacy'], t.navPrivacy)}
      <form method="post" action="/auth/logout">
        <input type="hidden" name="csrf" value={csrfToken} />
        <button type="submit">{t.signOut}</button>
      </form>
    </nav>
  );
}

/**
 * The frame around every account page: the layout theme (staff's choice), the visitor's colour and the shared
 * player. A theme changes only this frame and the home page; phones keep one layout whatever the theme.
 */
export function AppFrame({ theme, accent: initial, lang, csrfToken, children }: { theme: WebThemeId; accent: WebAccentId; lang: Lang; csrfToken: string | null; children: React.ReactNode }) {
  const [accent, set] = useState(initial);
  const setAccent = (a: WebAccentId) => {
    set(a);
    document.cookie = `${ACCENT_COOKIE}=${a}; Path=/; Max-Age=31536000; SameSite=Lax${location.protocol === 'https:' ? '; Secure' : ''}`;
  };
  return (
    <AccentCtx.Provider value={{ accent, setAccent }}>
      <div className={`app-frame t-${theme}`} data-accent={accent} data-testid="app-frame">
        <PlayerProvider lang={lang}>
          {theme === 'radio-wall' && csrfToken && <SideNav lang={lang} csrfToken={csrfToken} />}
          {children}
        </PlayerProvider>
      </div>
    </AccentCtx.Provider>
  );
}
