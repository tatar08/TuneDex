'use client';

import { useEffect, useState } from 'react';
import { formatDate, formatDateTime, RATE_LIMITED, REASON_LABELS, RIGHTS_BASIS_LABELS, RIGHTS_FIELD_LABELS, RIGHTS_STATE_LABELS, RIGHTS_STATUS_LABELS } from '@/lib/admin';
import type { AdminStation, RightsRecord } from '@/lib/bff';
import { useAdmin } from '../AdminShell';

type Form = { holder: string; basis: string; reference: string; territories: string; validFrom: string; expiresAt: string; evidenceRefs: string };

const today = () => new Date().toISOString().slice(0, 10);
const emptyForm = (country: string): Form => ({ holder: '', basis: '', reference: '', territories: country, validFrom: today(), expiresAt: '', evidenceRefs: '' });

/** Staff-facing message for a failed rights call; field errors name the field in Thai. */
function failure(status: number, body: Record<string, any>): string {
  const d = body.details ?? {};
  if (status === 400 && d.field) return `${RIGHTS_FIELD_LABELS[d.field] ?? d.field}: ${REASON_LABELS[d.reason] ?? d.reason}`;
  if (status === 409 && body.code === 'RIGHTS_ALREADY_REVOKED') return 'หลักฐานนี้ถูกเพิกถอนไปแล้ว';
  if (status === 401) return 'หมดเวลาเข้าใช้งาน กรุณาเข้าสู่ระบบอีกครั้ง';
  if (status === 403) return 'บัญชีนี้ไม่มีสิทธิ์จัดการหลักฐานสิทธิ์';
  if (status === 404) return 'ไม่พบสถานีหรือหลักฐานนี้';
  if (status === 429) return `${RATE_LIMITED} ยังไม่ได้บันทึก`;
  return 'ระบบไม่พร้อมใช้งานชั่วคราว ยังไม่ได้บันทึก';
}

/**
 * Rights evidence for one station (Doc 17): the records with status, territory and expiry, a form to add one and a
 * revoke with reason. Changes apply at once: the publish gate and the public catalog follow the records.
 * Evidence keys are private storage keys; they are shown here for staff and never reach the apps.
 */
export function RightsPanel({ station, onChanged }: { station: AdminStation; onChanged: () => void }) {
  const { csrfToken, canEdit } = useAdmin();
  const [records, setRecords] = useState<RightsRecord[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [form, setForm] = useState<Form>(() => emptyForm(station.draft.country));
  const [revoking, setRevoking] = useState<string | null>(null);
  const [revokeReason, setRevokeReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);

  async function load() {
    try {
      const res = await fetch(`/bff/admin/stations/${station.id}/rights`);
      if (!res.ok) throw new Error(String(res.status));
      setRecords(((await res.json()) as { records: RightsRecord[] }).records);
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
  }
  useEffect(() => {
    void load();
  }, [station.id]);

  async function send(url: string, body: unknown): Promise<boolean> {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify(body) });
      if (res.ok) return true;
      setMessage({ ok: false, text: failure(res.status, await res.json().catch(() => ({}))) });
    } catch {
      setMessage({ ok: false, text: 'เชื่อมต่อระบบไม่ได้ ยังไม่ได้บันทึก ลองอีกครั้ง' });
    } finally {
      setBusy(false);
    }
    return false;
  }

  async function add(e: React.FormEvent) {
    e.preventDefault();
    const ok = await send(`/bff/admin/stations/${station.id}/rights`, {
      holder: form.holder,
      basis: form.basis,
      reference: form.reference,
      territories: form.territories.split(/[\s,]+/).map((t) => t.trim().toUpperCase()).filter(Boolean),
      validFrom: form.validFrom || undefined,
      expiresAt: form.expiresAt || null,
      evidenceRefs: form.evidenceRefs.split('\n').map((r) => r.trim()).filter(Boolean),
    });
    if (!ok) return;
    setForm(emptyForm(station.draft.country));
    setMessage({ ok: true, text: 'เพิ่มหลักฐานสิทธิ์แล้ว มีผลทันที' });
    await load();
    onChanged();
  }

  async function revoke(id: string) {
    const ok = await send(`/bff/admin/stations/${station.id}/rights/${id}/revoke`, { reason: revokeReason });
    if (!ok) return;
    setRevoking(null);
    setRevokeReason('');
    setMessage({ ok: true, text: 'เพิกถอนแล้ว ถ้าไม่มีหลักฐานอื่นครอบคลุม แอปจะไม่เห็นสถานีนี้ทันที' });
    await load();
    onChanged();
  }

  const set = (k: keyof Form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <section className="adm-panel rt-panel" aria-label="หลักฐานสิทธิ์">
      <h3>หลักฐานสิทธิ์</h3>
      <p className={`rt-summary ${station.rights.state}`}>
        {RIGHTS_STATE_LABELS[station.rights.state]}
        {station.rights.state === 'current' && (station.rights.expiresAt ? ` ถึง ${formatDate(station.rights.expiresAt)}` : ' ไม่มีวันหมดอายุ')}
        {` · ประเทศ ${station.draft.country}`}
      </p>
      {loadFailed && <p className="adm-alert">โหลดหลักฐานสิทธิ์ไม่ได้ ลองโหลดหน้าใหม่</p>}
      {records && records.length === 0 && <p className="dim">ยังไม่มีหลักฐานสิทธิ์ ต้องมีอย่างน้อยหนึ่งรายการที่ครอบคลุมประเทศของสถานีจึงจะเผยแพร่ได้</p>}
      {records && records.length > 0 && (
        <ul className="rt-list">
          {records.map((r) => (
            <li key={r.id} className={r.effectiveStatus}>
              <div className="rt-head">
                <b>{RIGHTS_BASIS_LABELS[r.basis] ?? r.basis}</b>
                <span className={`rt-st ${r.effectiveStatus}`}>{RIGHTS_STATUS_LABELS[r.effectiveStatus]}</span>
              </div>
              <span>
                {r.territories.join(', ')} · {formatDate(r.validFrom)} – {r.expiresAt ? formatDate(r.expiresAt) : 'ไม่มีวันหมดอายุ'}
              </span>
              <small>
                {RIGHTS_FIELD_LABELS.holder}: {r.holder} · {RIGHTS_FIELD_LABELS.reference}: {r.reference}
              </small>
              {r.evidenceRefs && r.evidenceRefs.length > 0 && (
                <small>
                  {RIGHTS_FIELD_LABELS.evidenceRefs}: <span className="mono">{r.evidenceRefs.join(', ')}</span>
                </small>
              )}
              <small className="dim">
                {r.createdBy ? `เพิ่มโดย ${r.createdBy}` : 'ย้ายมาจากข้อมูลเดิม'} · {formatDateTime(r.createdAt)}
              </small>
              {r.status === 'revoked' && (
                <small className="rt-revoked">
                  เพิกถอนโดย {r.revokedBy ?? '—'} · {formatDateTime(r.revokedAt)} · {r.revokeReason}
                </small>
              )}
              {canEdit && r.status === 'active' && revoking !== r.id && (
                <button type="button" className="adm-link" onClick={() => (setRevoking(r.id), setRevokeReason(''))}>
                  เพิกถอน
                </button>
              )}
              {revoking === r.id && (
                <div className="rt-revoke">
                  <label className="fld">
                    <span>{RIGHTS_FIELD_LABELS.reason} (บันทึกใน audit)</span>
                    <textarea value={revokeReason} onChange={(e) => setRevokeReason(e.target.value)} maxLength={500} rows={2} />
                  </label>
                  <div className="ed-actions">
                    <button type="button" className="btn danger" disabled={!ready || busy || !revokeReason.trim()} onClick={() => revoke(r.id)}>
                      ยืนยันเพิกถอน
                    </button>
                    <button type="button" className="btn secondary" disabled={busy} onClick={() => setRevoking(null)}>
                      ยกเลิก
                    </button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className={message ? (message.ok ? 'adm-ok' : 'adm-alert') : 'sr-only'} role="status">
        {message?.text}
      </p>
      {canEdit && (
        <details className="rt-add">
          <summary>เพิ่มหลักฐานสิทธิ์</summary>
          <form onSubmit={add} aria-label="เพิ่มหลักฐานสิทธิ์">
            <label className="fld">
              <span>{RIGHTS_FIELD_LABELS.holder}</span>
              <input value={form.holder} onChange={set('holder')} maxLength={200} required placeholder="เช่น บริษัทเจ้าของสถานี" />
            </label>
            <label className="fld">
              <span>{RIGHTS_FIELD_LABELS.basis}</span>
              <select value={form.basis} onChange={set('basis')} required>
                <option value="">— เลือก —</option>
                {Object.entries(RIGHTS_BASIS_LABELS).map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
            <label className="fld">
              <span>{RIGHTS_FIELD_LABELS.reference}</span>
              <input value={form.reference} onChange={set('reference')} maxLength={200} required placeholder="เช่น เลขสัญญา หรือเลขตั๋ว" />
            </label>
            <label className="fld">
              <span>{RIGHTS_FIELD_LABELS.territories}</span>
              <input value={form.territories} onChange={set('territories')} required placeholder="TH, LA" />
            </label>
            <div className="row2">
              <label className="fld">
                <span>{RIGHTS_FIELD_LABELS.validFrom}</span>
                <input type="date" value={form.validFrom} onChange={set('validFrom')} />
              </label>
              <label className="fld">
                <span>{RIGHTS_FIELD_LABELS.expiresAt}</span>
                <input type="date" value={form.expiresAt} onChange={set('expiresAt')} />
              </label>
            </div>
            <label className="fld">
              <span>{RIGHTS_FIELD_LABELS.evidenceRefs} (บรรทัดละหนึ่ง ไม่บังคับ)</span>
              <textarea value={form.evidenceRefs} onChange={set('evidenceRefs')} rows={2} placeholder="rights/2026/contract-014.pdf" />
            </label>
            <p className="dim">ใส่รหัสไฟล์ในที่เก็บส่วนตัวเท่านั้น ห้ามใส่ลิงก์ รหัสนี้ไม่ถูกส่งไปที่แอป</p>
            <button type="submit" className="btn" disabled={!ready || busy}>
              {busy ? 'กำลังบันทึก…' : 'เพิ่มหลักฐาน'}
            </button>
          </form>
        </details>
      )}
    </section>
  );
}
