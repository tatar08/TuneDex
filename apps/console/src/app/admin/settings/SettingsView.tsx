'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { formatLogTime } from '@/lib/admin';
import { WEB_THEMES, webThemeFrom } from '@/lib/web-themes';
import { useAdmin, useT } from '../AdminShell';
import { LogoUpload } from '../LogoUpload';

/**
 * System settings (Tar 2026-10-10). For now one thing: TuneDeck's logo, shown on the map and in lists for every
 * community station without a logo of its own. One layout for every theme, in the theme's own colours.
 */
export function SettingsView({
  brand,
  webTheme,
}: {
  brand: { custom: boolean; version?: string } | null;
  /** Null for staff who are not admins: only admins choose the web app's layout. */
  webTheme: { theme: string; updatedBy: string | null; updatedAt: string | null } | null;
}) {
  const t = useT();
  return (
    <div className="st-page">
      <h2>{t('ตั้งค่าระบบ')}</h2>
      {webTheme && <WebThemePicker current={webTheme} />}
      {brand ? (
        <section className="adm-note lg-brand" aria-labelledby="st-logo">
          <h3 id="st-logo">{t('โลโก้ TuneDeck สำหรับสถานีที่ไม่มีโลโก้')}</h3>
          <p className="dim">{t('แสดงบนแผนที่และในรายการแทนสถานีที่ไม่มีโลโก้ของตัวเอง เปลี่ยนแล้วมีผลภายในไม่กี่นาที')}</p>
          <LogoUpload
            src={`/bff/logos/default?r=${brand.version ?? 'built-in'}`}
            note={brand.custom ? t('โลโก้ที่ทีมงานอัปโหลด') : t('โลโก้มาตรฐานของ TuneDeck')}
            uploaded={brand.custom}
            path="/bff/admin/brand/station-logo"
            name="TuneDeck"
            label={t('อัปโหลดโลโก้ใหม่')}
          />
        </section>
      ) : (
        <div className="adm-alert" role="alert">
          {t('บัญชีนี้ไม่มีสิทธิ์ หรือโหลดข้อมูลไม่ได้ในขณะนี้ ลองโหลดหน้าใหม่')}
        </div>
      )}
      <p className="dim">
        {t('เปลี่ยนโลโก้ของแต่ละสถานีได้ที่หน้า')} <Link href="/admin/directory">{t('วิทยุทั่วโลก')}</Link>
      </p>
    </div>
  );
}

/**
 * The layout every visitor of the web app gets (Tar 2026-10-11). Visitors cannot change it; they choose only a
 * colour on their own settings page. Takes effect within about a minute, and is recorded in the audit trail.
 */
function WebThemePicker({ current }: { current: { theme: string; updatedBy: string | null; updatedAt: string | null } }) {
  const { csrfToken, t } = useAdmin();
  const router = useRouter();
  const [picked, setPicked] = useState(webThemeFrom(current.theme));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [saved, setSaved] = useState(false);

  async function save(ev: React.FormEvent) {
    ev.preventDefault();
    setBusy(true);
    setProblem('');
    setSaved(false);
    const res = await fetch('/bff/admin/brand/web-theme', { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify({ theme: picked }) }).catch(() => null);
    setBusy(false);
    if (!res?.ok) return setProblem(res?.status === 403 ? t('เฉพาะแอดมินเท่านั้นที่เปลี่ยนธีมของเว็บได้') : res?.status === 401 ? t('หมดเวลาใช้งาน เข้าสู่ระบบใหม่แล้วลองอีกครั้ง') : t('บันทึกไม่ได้ในขณะนี้ ลองใหม่อีกครั้ง'));
    setSaved(true);
    router.refresh();
  }

  return (
    <form className="adm-panel st-theme" aria-labelledby="st-theme" onSubmit={save}>
      <h3 id="st-theme">{t('ธีมของเว็บผู้ใช้')}</h3>
      <p className="dim">{t('โครงหน้าที่ผู้ใช้ทุกคนเห็นบนคอมพิวเตอร์ ผู้ใช้เปลี่ยนเองไม่ได้ เลือกได้แค่สีในหน้าการตั้งค่าของตัวเอง มือถือใช้แบบเดียวทุกธีม')}</p>
      <div className="st-themes" role="radiogroup" aria-labelledby="st-theme">
        {WEB_THEMES.map((th) => (
          <label key={th.id} className={picked === th.id ? 'st-theme-card on' : 'st-theme-card'}>
            <input type="radio" name="web-theme" value={th.id} checked={picked === th.id} onChange={() => setPicked(th.id)} />
            <b>{t(th.name)}</b>
            <small className="dim">{t(th.hint)}</small>
          </label>
        ))}
      </div>
      {current.updatedAt && <small className="dim">{t('เปลี่ยนล่าสุดโดย {0} · {1}', current.updatedBy ?? '—', formatLogTime(current.updatedAt, t.lang))}</small>}
      {problem && (
        <p role="alert" className="au-export-err">
          {problem}
        </p>
      )}
      {saved && <p role="status">{t('บันทึกแล้ว ผู้ใช้จะเห็นธีมใหม่ภายในประมาณหนึ่งนาที')}</p>}
      <div className="row">
        <button type="submit" className="btn" disabled={busy || picked === webThemeFrom(current.theme)}>
          {busy ? t('กำลังบันทึก…') : t('ใช้ธีมนี้กับผู้ใช้ทุกคน')}
        </button>
      </div>
    </form>
  );
}
