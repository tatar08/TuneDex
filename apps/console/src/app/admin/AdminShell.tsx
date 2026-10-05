'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { createContext, Suspense, useContext, useEffect, useState } from 'react';
import { canSeeAudit, canSeeConfig, canSeeLogs, canSeeStations, canSeeUsers, CatalogSummary, Mode, MODE_COOKIE, ROLE_LABELS, THEME_COOKIE, THEMES, ThemeId } from '@/lib/admin';
import { Translate, translator } from '@/lib/admin-i18n';
import type { StaffRole } from '@/lib/bff';
import type { Lang } from '@/lib/i18n';

interface AdminContextValue {
  theme: ThemeId;
  summary: CatalogSummary | null;
  roles: StaffRole[];
  csrfToken: string;
  canEdit: boolean;
  isAdmin: boolean;
  lang: Lang;
  t: Translate;
}

const AdminContext = createContext<AdminContextValue | null>(null);
export function useAdmin(): AdminContextValue {
  const v = useContext(AdminContext);
  if (!v) throw new Error('useAdmin outside AdminShell');
  return v;
}
/** The staff console's translate function for the viewer's language (Thai unless they switched). */
export const useT = (): Translate => useAdmin().t;

const NAV = [
  { href: '/admin/overview', label: 'ภาพรวมระบบ', short: 'OV', icon: 'bolt', show: canSeeLogs },
  { href: '/admin/stations', label: 'สถานีวิทยุ', short: 'ST', icon: 'stations', show: canSeeStations },
  { href: '/admin/directory', label: 'วิทยุทั่วโลก', short: 'WR', icon: 'globe', show: canSeeStations },
  { href: '/admin/logs', label: 'บันทึกระบบ', short: 'LG', icon: 'logs', show: canSeeLogs },
  { href: '/admin/jobs', label: 'งานเบื้องหลัง', short: 'JB', icon: 'jobs', show: canSeeLogs },
  { href: '/admin/users', label: 'ผู้ใช้', short: 'US', icon: 'users', show: canSeeUsers },
  { href: '/admin/config', label: 'ตั้งค่าแอป', short: 'CF', icon: 'config', show: canSeeConfig },
  { href: '/admin/audit', label: 'ประวัติการแก้ไข', short: 'AU', icon: 'audit', show: canSeeAudit },
] as const;

function ThemePicker({ theme, onChange }: { theme: ThemeId; onChange: (t: ThemeId) => void }) {
  const t = useT();
  return (
    <label className="adm-theme">
      <span>{t('ธีม')}</span>
      <select value={theme} onChange={(e) => onChange(e.target.value as ThemeId)} aria-label={t('เลือกธีมหน้าทีมงาน')}>
        {THEMES.map((th) => (
          <option key={th.id} value={th.id}>
            {th.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function SignOut({ csrfToken, className }: { csrfToken: string; className?: string }) {
  const t = useT();
  return (
    <form method="post" action="/auth/logout" className={className}>
      <input type="hidden" name="csrf" value={csrfToken} />
      <button type="submit" className="adm-link">{t('ออกจากระบบ')}</button>
    </form>
  );
}

/** Live Thailand-time clock for the Broadcast Rack display. */
function Vfd() {
  const t = useT();
  const [now, setNow] = useState<string>('');
  useEffect(() => {
    const fmt = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Asia/Bangkok', hour12: false });
    const tick = () => setNow(fmt.format(new Date()));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <span className="vfd" aria-label={t('เวลาประเทศไทย')}>
      BKK {now || '--:--:--'}
    </span>
  );
}

const ICONS = {
  radio: 'M4 10h16v10H4zM8 6l9-3M8 15h.01M15 15a2 2 0 100-.01',
  stations: 'M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6',
  me: 'M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z',
  search: 'M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z',
  sun: 'M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z',
  moon: 'M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z',
  logout: 'M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1',
  chevron: 'M15 19l-7-7 7-7',
  bolt: 'M13 10V3L4 14h7v7l9-11h-7z',
  globe: 'M21 12a9 9 0 11-18 0 9 9 0 0118 0zM3.6 9h16.8M3.6 15h16.8M12 3a15 15 0 010 18M12 3a15 15 0 000 18',
  config: 'M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4',
  users: 'M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z',
  jobs: 'M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15',
  audit: 'M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z',
  logs: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9h6m-6-4h6m-6 8h4',
} as const;

export function Icon({ name, className }: { name: keyof typeof ICONS; className?: string }) {
  return (
    <svg className={className ?? 'ico'} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICONS[name]} />
    </svg>
  );
}

/** Sidebar search: filters the station list by name. */
function SideSearch() {
  const t = useT();
  const router = useRouter();
  const params = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  return (
    <form
      role="search"
      className="fv-search"
      onSubmit={(e) => {
        e.preventDefault();
        router.push(q.trim() ? `/admin/stations?q=${encodeURIComponent(q.trim())}` : '/admin/stations');
      }}
    >
      <Icon name="search" />
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('ค้นหาสถานี…')} aria-label={t('ค้นหาสถานี')} />
    </form>
  );
}

export function AdminShell({
  theme: initialTheme,
  mode: initialMode,
  roles,
  summary,
  csrfToken,
  fontClass,
  lang,
  children,
}: {
  lang: Lang;
  theme: ThemeId;
  mode: Mode;
  summary: CatalogSummary | null;
  roles: StaffRole[];
  csrfToken: string;
  fontClass: string;
  children: React.ReactNode;
}) {
  const [theme, setTheme] = useState<ThemeId>(initialTheme);
  const [mode, setMode] = useState<Mode>(initialMode);
  const [collapsed, setCollapsed] = useState(false);
  const pathname = usePathname();
  const isAdmin = roles.includes('admin');
  const t = translator(lang);
  const value: AdminContextValue = { theme, summary, roles, csrfToken, isAdmin, canEdit: isAdmin || roles.includes('catalog_editor'), lang, t };
  const who = roles.map((r) => t(ROLE_LABELS[r])).join(', ');
  const nav = NAV.filter((n) => n.show(roles));
  const on = (href: string) => pathname === href || pathname.startsWith(`${href}/`);

  function changeTheme(next: ThemeId) {
    setTheme(next);
    // A per-viewer display preference, not a secret: readable cookie scoped to /admin.
    const secure = location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = `${THEME_COOKIE}=${next}; Path=/admin; Max-Age=31536000; SameSite=Lax${secure}`;
  }

  function changeMode(m: Mode) {
    setMode(m);
    const secure = location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = `${MODE_COOKIE}=${m}; Path=/admin; Max-Age=31536000; SameSite=Lax${secure}`;
  }

  // The language switch sits with the theme picker in every layout; it comes back to the same page.
  const picker = (
    <>
      <ThemePicker theme={theme} onChange={changeTheme} />
      <a className="adm-link adm-lang" href={`/lang?to=${lang === 'th' ? 'en' : 'th'}&returnTo=${encodeURIComponent(pathname)}`} lang={lang === 'th' ? 'en' : 'th'}>
        {lang === 'th' ? 'English' : 'ภาษาไทย'}
      </a>
    </>
  );
  const links = nav.map((n) => (
    <Link key={n.href} href={n.href} className={on(n.href) ? 'on' : undefined} aria-current={on(n.href) ? 'page' : undefined}>
      {t(n.label)}
    </Link>
  ));

  let chrome: React.ReactNode;
  switch (theme) {
    case 'control-room':
      chrome = (
        <>
          <aside className="side">
            <div className="logo">
              TuneDeck <span>· console</span>
            </div>
            <nav className="grp" aria-label={t('เมนู')}>
              <h6>Console</h6>
              {links}
            </nav>
            <nav className="grp" aria-label={t('บัญชี')}>
              <h6>Account</h6>
              <a href="/app/settings">{t('การตั้งค่าของฉัน')}</a>
            </nav>
            <div className="me">
              <b>{who}</b>
              <span>{t('หมดเวลาเมื่อไม่ใช้งาน 30 นาที')}</span>
              {picker}
              <SignOut csrfToken={csrfToken} />
            </div>
          </aside>
          <main className="main">{children}</main>
        </>
      );
      break;
    case 'broadcast-rack':
      chrome = (
        <>
          <header className="bar">
            <span className="brand">
              TUNE<span>DECK</span>
            </span>
            <nav className="bands" aria-label={t('เมนู')}>
              {links}
              <a href="/app/settings">{t('ตั้งค่าของฉัน')}</a>
            </nav>
            <Vfd />
            <span className="who">
              <b>{who}</b>
            </span>
            {picker}
            <SignOut csrfToken={csrfToken} />
          </header>
          <main className="body">{children}</main>
        </>
      );
      break;
    case 'daylight-bento':
      chrome = (
        <>
          <header className="nav">
            <span className="lg">
              <i aria-hidden="true" />
              TuneDeck
            </span>
            <nav aria-label={t('เมนู')}>
              {links}
              <a href="/app/settings">{t('ตั้งค่าของฉัน')}</a>
            </nav>
            <span className="av">
              {picker}
              <span>{who}</span>
              <b aria-hidden="true">{who.slice(0, 1)}</b>
              <SignOut csrfToken={csrfToken} />
            </span>
          </header>
          <main className="page">{children}</main>
        </>
      );
      break;
    case 'workbench':
      chrome = (
        <>
          <nav className="rail" aria-label={t('เมนู')}>
            <span className="lg" aria-hidden="true">
              T
            </span>
            {nav.map((n) => (
              <Link key={n.href} href={n.href} className={on(n.href) ? 'on' : undefined} title={t(n.label)} aria-label={t(n.label)} aria-current={on(n.href) ? 'page' : undefined}>
                {n.short}
              </Link>
            ))}
            <a href="/app/settings" title={t('ตั้งค่าของฉัน')} aria-label={t('ตั้งค่าของฉัน')}>
              ME
            </a>
          </nav>
          <div className="wb">
            <header className="wb-top">
              <span>{who}</span>
              {picker}
              <SignOut csrfToken={csrfToken} />
            </header>
            {children}
          </div>
        </>
      );
      break;
    default:
      chrome = (
        <>
          <aside className={`fv-side${collapsed ? ' collapsed' : ''}`}>
            <button type="button" className="fv-collapse" onClick={() => setCollapsed((c) => !c)} aria-label={collapsed ? t('ขยายเมนู') : t('ยุบเมนู')} aria-expanded={!collapsed}>
              <Icon name="chevron" />
            </button>
            <div className="fv-side-top">
              <div className="fv-brand">
                <span className="fv-logo">
                  <Icon name="radio" />
                </span>
                <span className="fv-text">
                  <b>TuneDeck</b>
                  <small>Staff Console</small>
                </span>
              </div>
              <Suspense>
                <SideSearch />
              </Suspense>
              <nav className="fv-menu" aria-label={t('เมนู')}>
                <span className="fv-section">{t('เมนู')}</span>
                {nav.map((n) => (
                  <Link key={n.href} href={n.href} className={on(n.href) ? 'on' : undefined} aria-current={on(n.href) ? 'page' : undefined} title={t(n.label)}>
                    <Icon name={n.icon} />
                    <span className="fv-text">{t(n.label)}</span>
                    {n.href === '/admin/stations' && summary && summary.pending > 0 && (
                      <span className="fv-badge" aria-label={t('รอตรวจ {0}', summary.pending)}>
                        {summary.pending}
                      </span>
                    )}
                  </Link>
                ))}
                <a href="/app/settings" title={t('ตั้งค่าของฉัน')}>
                  <Icon name="me" />
                  <span className="fv-text">{t('ตั้งค่าของฉัน')}</span>
                </a>
              </nav>
            </div>
            <div className="fv-side-foot">
              <div className="fv-text">{picker}</div>
              <div className="fv-mode" role="group" aria-label={t('โหมดสี')}>
                <button type="button" className={mode === 'light' ? 'on' : undefined} aria-pressed={mode === 'light'} onClick={() => changeMode('light')} title="Light">
                  <Icon name="sun" />
                  <span className="fv-text">Light</span>
                </button>
                <button type="button" className={mode === 'dark' ? 'on' : undefined} aria-pressed={mode === 'dark'} onClick={() => changeMode('dark')} title="Dark">
                  <Icon name="moon" />
                  <span className="fv-text">Dark</span>
                </button>
              </div>
              <div className="fv-user">
                <span className="fv-avatar" aria-hidden="true">
                  <Icon name="me" />
                </span>
                <span className="fv-text">
                  <b>{who}</b>
                  <small>{t('หมดเวลาเมื่อไม่ใช้งาน 30 นาที')}</small>
                </span>
                <form method="post" action="/auth/logout">
                  <input type="hidden" name="csrf" value={csrfToken} />
                  <button type="submit" className="fv-out" aria-label={t('ออกจากระบบ')} title={t('ออกจากระบบ')}>
                    <Icon name="logout" />
                  </button>
                </form>
              </div>
            </div>
          </aside>
          <main className="fv-main">
            <header className="fv-head">
              <div className="fv-title">
                <span className="fv-mark">
                  <Icon name="bolt" />
                </span>
                <div>
                  <h1>
                    TuneDeck Console{' '}
                    {summary ? <span className="fv-live">{t('เชื่อมต่อ API แล้ว')}</span> : canSeeStations(roles) && <span className="fv-live off">{t('โหลดข้อมูลสรุปไม่ได้')}</span>}
                  </h1>
                  <p>{t('จัดการแค็ตตาล็อกสถานีวิทยุที่แอปจะเห็น')}</p>
                </div>
              </div>
              {summary && (
                <div className="fv-tele">
                  <div>
                    <small>{t('แอปเห็นอยู่')}</small>
                    <b>{t('{0} สถานี', summary.visible)}</b>
                  </div>
                  <i aria-hidden="true" />
                  <div className="due">
                    <small>{t('รอตรวจ')}</small>
                    <b>{t('{0} สถานี', summary.pending)}</b>
                  </div>
                </div>
              )}
            </header>
            {children}
          </main>
        </>
      );
  }

  return (
    <AdminContext.Provider value={value}>
      <div className={`adm t-${theme} ${fontClass}`} data-theme-id={theme} data-mode={theme === 'minimal' ? mode : undefined}>
        {chrome}
      </div>
    </AdminContext.Provider>
  );
}
