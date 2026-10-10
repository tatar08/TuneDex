'use client';

import Link from 'next/link';
import { formatLogTime, RATE_LIMITED } from '@/lib/admin';
import type { DirectoryLogoSummary } from '@/lib/bff';
import { BUILT_IN_LOGO, logoPath } from '@/lib/logo';
import { useT } from '../AdminShell';
import { LogoUpload } from '../LogoUpload';

/**
 * System settings (Tar 2026-10-10). For now one thing: our own logo, shown on the map and in lists for every
 * community station that has no logo of its own. One layout for every theme, drawn with the theme's own colours.
 */
export function SettingsView({ status, logos }: { status: number; logos?: DirectoryLogoSummary }) {
  const t = useT();
  if (!logos) {
    return (
      <div className="adm-alert" role="alert">
        {status === 403 ? t('บัญชีนี้ไม่มีสิทธิ์ (ต้องเป็นผู้ดูแลแค็ตตาล็อกหรือแอดมิน)') : status === 429 ? t(RATE_LIMITED) : t('โหลดข้อมูลไม่ได้ในขณะนี้ ลองโหลดหน้าใหม่')}
      </div>
    );
  }
  const own = logos.default;
  return (
    <div className="st-page">
      <h2>{t('ตั้งค่าระบบ')}</h2>
      <section className="adm-panel" aria-labelledby="st-logo">
        <h3 id="st-logo">{t('โลโก้ของเรา')}</h3>
        <p className="dim">{t('ใช้กับสถานีวิทยุทั่วโลกที่ไม่มีโลโก้ของตัวเอง ทั้งบนแผนที่และในรายการสถานี')}</p>
        <div className="st-logo">
          <img src={own ? logoPath('default', own.version) : BUILT_IN_LOGO} alt={t('โลโก้ของเราที่ใช้อยู่')} width={96} height={96} data-testid="default-logo" />
          <div className="st-logo-text">
            <b>{own ? t('โลโก้ที่อัปโหลด') : t('โลโก้ที่มากับระบบ')}</b>
            <small className="dim">{own ? t('อัปโหลดโดย {0} · {1}', own.updatedBy ?? '—', formatLogTime(own.updatedAt, t.lang)) : t('ยังไม่มีใครอัปโหลดโลโก้ ระบบจึงใช้โลโก้ที่มากับระบบ')}</small>
            <LogoUpload logoKey="default" uploaded={!!own} label={t('เปลี่ยนโลโก้')} removeLabel={t('กลับไปใช้โลโก้ที่มากับระบบ')} className="btn" />
          </div>
        </div>
      </section>
      <section className="adm-panel" aria-labelledby="st-station-logos">
        <h3 id="st-station-logos">{t('โลโก้ของแต่ละสถานี')}</h3>
        <p>{t('มี {0} สถานีที่ทีมงานอัปโหลดโลโก้ให้เอง', logos.stations)}</p>
        <p className="dim">
          {t('เปลี่ยนโลโก้ของสถานีได้ที่หน้า')} <Link href="/admin/directory">{t('วิทยุทั่วโลก')}</Link>
        </p>
      </section>
    </div>
  );
}
