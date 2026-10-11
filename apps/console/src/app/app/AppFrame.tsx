'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { Lang, strings } from '@/lib/i18n';
import { ACCENT_COOKIE, WebAccentId, WebThemeId } from '@/lib/web-themes';
import { Icon, ICONS } from './AppNav';
import { ListeningPanel } from './player/ListeningPanel';
import { ExplorerNav, ExplorerProvider } from './ExplorerUI';
import { useDesktop } from './desktop';
import { PlayerProvider } from './player/Player';

const ThemeCtx = createContext<WebThemeId>('classic');
export const useWebTheme = () => useContext(ThemeCtx);

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

/** Top navigation for the preset wall. Account destinations stay in one disclosure. */
function TopNav({ lang, csrfToken }: { lang: Lang; csrfToken: string }) {
  const t = strings(lang);
  const path = usePathname();
  const account = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (account.current) account.current.open = false;
  }, [path]);
  const link = (href: string, text: string) => (
    <Link href={href} key={href} prefetch={false} aria-current={path === href ? 'page' : undefined}>{text}</Link>
  );
  return (
    <nav className="theme-top-nav" aria-label={t.navMenu}>
      <Link href="/app/home" className="brand" prefetch={false}>{t.appName}</Link>
      {link('/app/home', t.navHome)}
      {link('/app/radio', t.navRadio)}
      {link('/app/explore', t.navExplore)}
      <details ref={account} className="theme-account">
        <summary>{t.navAccount}</summary>
        <div>
          {link('/app/overview', t.navOverview)}
          {link('/app/settings', t.navSettings)}
          {link('/app/devices', t.navDevices)}
          {link('/app/privacy', t.navPrivacy)}
          <form method="post" action="/auth/logout">
            <input type="hidden" name="csrf" value={csrfToken} />
            <button type="submit">{t.signOut}</button>
          </form>
        </div>
      </details>
    </nav>
  );
}

/**
 * The frame around every account page: the layout theme (staff's choice), the visitor's colour and the shared
 * player. A theme changes only this frame and the home page; phones keep one layout whatever the theme.
 */
export function AppFrame({ theme, accent: initial, lang, csrfToken, children }: { theme: WebThemeId; accent: WebAccentId; lang: Lang; csrfToken: string | null; children: React.ReactNode }) {
  const [accent, set] = useState(initial);
  const wide = useDesktop();
  const top = ['preset-wall', 'listen-find', 'country-window', 'stage', 'cockpit', 'head-unit', 'signal-dial', 'language-lanes', 'daylight'].includes(theme);
  const side = ['tune-world', 'map-home', 'night-garden', 'explorer'].includes(theme);
  const extra = ['listen-find', 'country-window', 'stage', 'cockpit', 'head-unit', 'signal-dial', 'language-lanes', 'tune-world', 'map-home', 'night-garden', 'daylight', 'explorer'].includes(theme);
  const setAccent = (a: WebAccentId) => {
    set(a);
    document.cookie = `${ACCENT_COOKIE}=${a}; Path=/; Max-Age=31536000; SameSite=Lax${location.protocol === 'https:' ? '; Secure' : ''}`;
  };
  return (
    <ExplorerProvider><ThemeCtx.Provider value={theme}>
      <AccentCtx.Provider value={{ accent, setAccent }}>
      <div className={`app-frame t-${theme}${top ? ' desktop-top-frame' : ''}${side ? ' desktop-side-frame' : ''}${extra ? ' desktop-theme' : ''}`} data-accent={accent} data-testid="app-frame">
        <PlayerProvider lang={lang} explorer={theme === 'explorer' && wide}>
          {theme === 'explorer' && csrfToken && <ExplorerNav lang={lang} csrfToken={csrfToken} />}
          {((side && theme !== 'explorer') || ['radio-wall', 'shelves', 'studio'].includes(theme)) && csrfToken && <SideNav lang={lang} csrfToken={csrfToken} />}
          {top && csrfToken && <TopNav lang={lang} csrfToken={csrfToken} />}
          {children}
          {['listen-find', 'country-window'].includes(theme) && <ListeningPanel />}
        </PlayerProvider>
      </div>
      </AccentCtx.Provider>
    </ThemeCtx.Provider></ExplorerProvider>
  );
}
