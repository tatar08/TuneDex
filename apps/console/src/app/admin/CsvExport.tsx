'use client';

import { useEffect, useRef, useState } from 'react';
import { RATE_LIMITED } from '@/lib/admin';
import { useAdmin } from './AdminShell';
import { isMfaRequired, MfaLink, MFA_NEEDED } from './MfaPrompt';

export interface CsvExportProps {
  /** BFF route that takes the search in its query string and `{ reason }` in the body. */
  endpoint: string;
  /** The current search, without paging. Empty values are left out. */
  params: Record<string, string>;
  /** Shown when the API refuses the role. */
  forbidden: string;
  /** Accessible name of the reason form. */
  formLabel: string;
  /** What a row is called in the messages (รายการ, บรรทัด). */
  unit: string;
  fallbackName: string;
  className?: string;
}

/**
 * Doc 17 staff export (audit trail, logs): the current search as CSV, at most 10,000 rows. A reason is
 * required and is recorded with the export; MFA_REQUIRED offers the step-up link. Each theme places the button.
 */
export function CsvExport({ endpoint, params, forbidden, formLabel, unit, fallbackName, className = 'btn secondary' }: CsvExportProps) {
  const { csrfToken } = useAdmin();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [done, setDone] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (open) ref.current?.focus();
  }, [open]);

  const problems: Record<string, string> = {
    reason: 'เหตุผลต้องยาว 10–500 ตัวอักษร',
    filters: 'ตัวกรองไม่ถูกต้อง แก้แล้วค้นหาใหม่ก่อนส่งออก',
    too_many_rows: `ผลการค้นหาเกิน 10,000 ${unit} กรุณาแคบช่วงเวลาหรือเพิ่มตัวกรอง`,
    forbidden,
    expired: 'หมดเวลาเข้าใช้งาน กรุณาเข้าสู่ระบบอีกครั้ง',
    rate: RATE_LIMITED,
    down: 'ระบบไม่พร้อมใช้งานชั่วคราว ลองอีกครั้งภายหลัง',
  };

  async function submit(ev: React.FormEvent) {
    ev.preventDefault();
    setBusy(true);
    setProblem('');
    setDone('');
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v));
    try {
      const res = await fetch(`${endpoint}?${qs}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ reason }),
      });
      if (res.ok) {
        const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? fallbackName;
        const url = URL.createObjectURL(await res.blob());
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        a.click();
        URL.revokeObjectURL(url);
        setDone(`ดาวน์โหลด ${name} แล้ว การส่งออกนี้ถูกบันทึกพร้อมเหตุผล`);
        setReason('');
        setOpen(false);
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { code?: string; details?: { field?: string; reason?: string } };
      if (isMfaRequired(res.status, body)) return setProblem(MFA_NEEDED);
      setProblem(
        problems[
          res.status === 400
            ? body.details?.reason === 'too_many_rows'
              ? 'too_many_rows'
              : body.details?.field === 'reason'
                ? 'reason'
                : 'filters'
            : res.status === 403
              ? 'forbidden'
              : res.status === 401
                ? 'expired'
                : res.status === 429
                  ? 'rate'
                  : 'down'
        ],
      );
    } catch {
      setProblem(problems.down);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="au-export">
      <button type="button" className={className} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        ส่งออก CSV
      </button>
      {done && (
        <p className="au-export-done" role="status">
          {done}
        </p>
      )}
      {open && (
        <form className="au-export-panel" onSubmit={submit} aria-label={formLabel}>
          <label className="fld">
            <span>เหตุผลในการส่งออก (จะถูกบันทึกไว้)</span>
            <textarea ref={ref} value={reason} onChange={(e) => setReason(e.target.value)} minLength={10} maxLength={500} rows={3} required />
          </label>
          <small className="dim">ส่งออกตามตัวกรองที่ใช้อยู่ สูงสุด 10,000 {unit}</small>
          {problem && (
            <p role="alert" className="au-export-err">
              {problem}
              {problem === MFA_NEEDED && (
                <>
                  {' '}
                  <MfaLink />
                </>
              )}
            </p>
          )}
          <div className="lg-actions">
            <button type="submit" className="btn" disabled={busy || reason.trim().length < 10}>
              {busy ? 'กำลังส่งออก…' : 'ดาวน์โหลด CSV'}
            </button>
            <button type="button" className="adm-link" onClick={() => setOpen(false)}>
              ยกเลิก
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
