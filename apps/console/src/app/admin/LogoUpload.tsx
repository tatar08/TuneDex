'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { RATE_LIMITED } from '@/lib/admin';
import { prepareLogo } from '@/lib/logo';
import { useAdmin } from './AdminShell';

const PROBLEMS: Record<string, string> = {
  type: 'ไฟล์ต้องเป็นรูป PNG, JPEG หรือ WebP',
  size: 'รูปใหญ่เกินไป เลือกรูปที่เล็กกว่านี้',
  forbidden: 'บัญชีนี้ไม่มีสิทธิ์ (ต้องเป็นผู้ดูแลแค็ตตาล็อกหรือแอดมิน)',
  expired: 'หมดเวลาใช้งาน เข้าสู่ระบบใหม่แล้วลองอีกครั้ง',
  rate: RATE_LIMITED,
  down: 'บันทึกไม่ได้ในขณะนี้ ลองใหม่อีกครั้ง',
};

async function post(path: string, body: object, csrfToken: string): Promise<string | null> {
  try {
    const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify(body) });
    if (res.ok || res.status === 404) return null;
    return res.status === 400 ? 'type' : res.status === 413 ? 'size' : res.status === 403 ? 'forbidden' : res.status === 401 ? 'expired' : res.status === 429 ? 'rate' : 'down';
  } catch {
    return 'down';
  }
}

/**
 * Upload a logo for one community station, or our own (`logoKey` 'default'), and take an uploaded one away again
 * (Tar 2026-10-10). The picture is scaled to 256 px in the browser before it is sent; the API checks it again.
 */
export function LogoUpload({
  logoKey,
  uploaded,
  label,
  removeLabel,
  className = 'btn secondary',
}: {
  logoKey: string;
  /** Whether an uploaded logo is there to remove. */
  uploaded: boolean;
  label: string;
  removeLabel: string;
  className?: string;
}) {
  const { csrfToken, t } = useAdmin();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [ready, setReady] = useState<{ image: string; preview: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');

  const close = () => {
    setOpen(false);
    setReady(null);
    setProblem('');
  };
  async function choose(file: File | undefined) {
    setProblem('');
    setReady(null);
    if (!file) return;
    try {
      setReady(await prepareLogo(file));
    } catch (err) {
      setProblem(t(PROBLEMS[err instanceof Error && err.message === 'size' ? 'size' : 'type']));
    }
  }
  async function send(path: string, body: object) {
    setBusy(true);
    setProblem('');
    const p = await post(path, body, csrfToken);
    setBusy(false);
    if (p) return setProblem(t(PROBLEMS[p]));
    close();
    router.refresh();
  }

  return (
    <div className="jb-retry">
      <button type="button" className={className} aria-expanded={open} onClick={() => (open ? close() : setOpen(true))}>
        {label}
      </button>
      {open && (
        <form
          className="au-export-panel"
          aria-label={label}
          onSubmit={(ev) => {
            ev.preventDefault();
            if (ready) void send(`/bff/admin/directory/logos/${logoKey}`, { image: ready.image });
          }}
        >
          <label className="fld">
            <span>{t('เลือกรูป PNG, JPEG หรือ WebP (รูปสี่เหลี่ยมจัตุรัสจะสวยที่สุด)')}</span>
            <input type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => void choose(e.target.files?.[0])} />
          </label>
          {ready && <img className="lg-preview" src={ready.preview} alt={t('ตัวอย่างโลโก้')} width={96} height={96} />}
          <small className="dim">{t('ระบบจะย่อรูปเหลือไม่เกิน 256 พิกเซลก่อนบันทึก และบันทึกการเปลี่ยนไว้ในประวัติ')}</small>
          {problem && (
            <p role="alert" className="au-export-err">
              {problem}
            </p>
          )}
          <div className="row">
            <button type="submit" className="btn" disabled={busy || !ready}>
              {busy ? t('กำลังบันทึก…') : t('บันทึกโลโก้')}
            </button>
            {uploaded && (
              <button type="button" className="btn secondary" disabled={busy} onClick={() => void send(`/bff/admin/directory/logos/${logoKey}/remove`, {})}>
                {removeLabel}
              </button>
            )}
            <button type="button" className="btn secondary" onClick={close}>
              {t('ยกเลิก')}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
