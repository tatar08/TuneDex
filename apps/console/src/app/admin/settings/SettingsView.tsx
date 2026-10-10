'use client';

import Link from 'next/link';
import { useT } from '../AdminShell';
import { LogoUpload } from '../LogoUpload';

/**
 * System settings (Tar 2026-10-10). For now one thing: TuneDeck's logo, shown on the map and in lists for every
 * community station without a logo of its own. One layout for every theme, in the theme's own colours.
 */
export function SettingsView({ brand }: { brand: { custom: boolean; version?: string } | null }) {
  const t = useT();
  return (
    <div className="st-page">
      <h2>{t('ตั้งค่าระบบ')}</h2>
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
