'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { RATE_LIMITED } from '@/lib/admin';
import { shrinkLogo } from '@/lib/logo-image';
import { useAdmin } from './AdminShell';

/**
 * A logo with its source, a button to pick a new picture (shrunk in the browser before it is sent) and, when one was
 * uploaded, a button to remove it. Used for a community station's logo and for TuneDeck's own.
 */
export function LogoUpload({ src, note, uploaded, path, name, label }: { src: string; note: string; uploaded: boolean; path: string; name: string; label: string }) {
  const { csrfToken, t } = useAdmin();
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');

  async function post(url: string, body: object) {
    setBusy(true);
    setProblem('');
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify(body) });
      if (res.ok) return router.refresh();
      setProblem(
        t(
          res.status === 403
            ? 'บัญชีนี้ไม่มีสิทธิ์เปลี่ยนโลโก้นี้'
            : res.status === 401
              ? 'หมดเวลาใช้งาน เข้าสู่ระบบใหม่แล้วลองอีกครั้ง'
              : res.status === 400 || res.status === 413
                ? 'ใช้รูป PNG, JPEG หรือ WebP ที่ไม่ใหญ่เกินไป'
                : res.status === 429
                  ? RATE_LIMITED
                  : 'บันทึกไม่ได้ในขณะนี้ ลองใหม่อีกครั้ง',
        ),
      );
    } catch {
      setProblem(t('บันทึกไม่ได้ในขณะนี้ ลองใหม่อีกครั้ง'));
    } finally {
      setBusy(false);
    }
  }

  async function picked(file: File | undefined) {
    if (input.current) input.current.value = '';
    if (!file) return;
    const logo = await shrinkLogo(file);
    if (!logo) return setProblem(t('ใช้รูป PNG, JPEG หรือ WebP ที่ไม่ใหญ่เกินไป'));
    await post(path, logo);
  }

  return (
    <div className="jb-retry lg-upload">
      {/* eslint-disable-next-line @next/next/no-img-element -- a small same-origin image; no optimiser needed */}
      <img className="lg-thumb" src={src} alt={t('โลโก้ของ {0}', name)} width={32} height={32} loading="lazy" />
      <small className="dim">{note}</small>
      <input ref={input} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden aria-label={t('เลือกรูปโลโก้ของ {0}', name)} onChange={(e) => void picked(e.target.files?.[0])} />
      <button type="button" className="btn secondary" disabled={busy} onClick={() => input.current?.click()}>
        {busy ? t('กำลังบันทึก…') : label}
      </button>
      {uploaded && (
        <button type="button" className="btn secondary" disabled={busy} onClick={() => void post(`${path}/remove`, {})}>
          {t('ลบโลโก้ที่อัปโหลด')}
        </button>
      )}
      {problem && (
        <p role="alert" className="au-export-err">
          {problem}
        </p>
      )}
    </div>
  );
}
