'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { createContext, useContext, useEffect, useState } from 'react';
import { ROLE_LABELS, THEME_COOKIE, THEMES, ThemeId } from '@/lib/admin';
import type { StaffRole } from '@/lib/bff';

interface AdminContextValue {
  theme: ThemeId;
  roles: StaffRole[];
  csrfToken: string;
  canEdit: boolean;
  isAdmin: boolean;
}

const AdminContext = createContext<AdminContextValue | null>(null);
export function useAdmin(): AdminContextValue {
  const v = useContext(AdminContext);
  if (!v) throw new Error('useAdmin outside AdminShell');
  return v;
}

const NAV = [{ href: '/admin/stations', label: 'สถานีวิทยุ', short: 'ST' }];

function ThemePicker({ theme, onChange }: { theme: ThemeId; onChange: (t: ThemeId) => void }) {
  return (
    <label className="adm-theme">
      <span>ธีม</span>
      <select value={theme} onChange={(e) => onChange(e.target.value as ThemeId)} aria-label="เลือกธีมหน้าทีมงาน">
        {THEMES.map((t) => (
          <option key={t.id} value={t.id}>
            {t.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function SignOut({ csrfToken, className }: { csrfToken: string; className?: string }) {
  return (
    <form method="post" action="/auth/logout" className={className}>
      <input type="hidden" name="csrf" value={csrfToken} />
      <button type="submit" className="adm-link">ออกจากระบบ</button>
    </form>
  );
}

/** Live Thailand-time clock for the Broadcast Rack display. */
function Vfd() {
  const [now, setNow] = useState<string>('');
  useEffect(() => {
    const fmt = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Asia/Bangkok', hour12: false });
    const tick = () => setNow(fmt.format(new Date()));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <span className="vfd" aria-label="เวลาประเทศไทย">
      BKK {now || '--:--:--'}
    </span>
  );
}

export function AdminShell({
  theme: initialTheme,
  roles,
  csrfToken,
  fontClass,
  children,
}: {
  theme: ThemeId;
  roles: StaffRole[];
  csrfToken: string;
  fontClass: string;
  children: React.ReactNode;
}) {
  const [theme, setTheme] = useState<ThemeId>(initialTheme);
  const pathname = usePathname();
  const isAdmin = roles.includes('admin');
  const value: AdminContextValue = { theme, roles, csrfToken, isAdmin, canEdit: isAdmin || roles.includes('catalog_editor') };
  const who = roles.map((r) => ROLE_LABELS[r]).join(', ');
  const on = (href: string) => pathname === href || pathname.startsWith(`${href}/`);

  function changeTheme(t: ThemeId) {
    setTheme(t);
    // A per-viewer display preference, not a secret: readable cookie scoped to /admin.
    const secure = location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = `${THEME_COOKIE}=${t}; Path=/admin; Max-Age=31536000; SameSite=Lax${secure}`;
  }

  const picker = <ThemePicker theme={theme} onChange={changeTheme} />;
  const links = NAV.map((n) => (
    <Link key={n.href} href={n.href} className={on(n.href) ? 'on' : undefined} aria-current={on(n.href) ? 'page' : undefined}>
      {n.label}
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
            <nav className="grp" aria-label="แค็ตตาล็อก">
              <h6>Catalog</h6>
              {links}
            </nav>
            <nav className="grp" aria-label="บัญชี">
              <h6>Account</h6>
              <a href="/app/settings">การตั้งค่าของฉัน</a>
            </nav>
            <div className="me">
              <b>{who}</b>
              <span>หมดเวลาเมื่อไม่ใช้งาน 30 นาที</span>
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
            <nav className="bands" aria-label="เมนู">
              {links}
              <a href="/app/settings">ตั้งค่าของฉัน</a>
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
            <nav aria-label="เมนู">
              {links}
              <a href="/app/settings">ตั้งค่าของฉัน</a>
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
          <nav className="rail" aria-label="เมนู">
            <span className="lg" aria-hidden="true">
              T
            </span>
            {NAV.map((n) => (
              <Link key={n.href} href={n.href} className={on(n.href) ? 'on' : undefined} title={n.label} aria-label={n.label} aria-current={on(n.href) ? 'page' : undefined}>
                {n.short}
              </Link>
            ))}
            <a href="/app/settings" title="ตั้งค่าของฉัน" aria-label="ตั้งค่าของฉัน">
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
          <header className="nav">
            <span className="lg">TuneDeck</span>
            {links}
            <a href="/app/settings">ตั้งค่าของฉัน</a>
            <span className="me">{who}</span>
            {picker}
            <SignOut csrfToken={csrfToken} />
          </header>
          <main className="page">{children}</main>
        </>
      );
  }

  return (
    <AdminContext.Provider value={value}>
      <div className={`adm t-${theme} ${fontClass}`} data-theme-id={theme}>
        {chrome}
      </div>
    </AdminContext.Provider>
  );
}
