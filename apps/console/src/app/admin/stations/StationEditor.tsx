'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { RATE_LIMITED, BLOCKER_LABELS, FIELD_LABELS, formatDateTime, REASON_LABELS, STATUS_LABELS } from '@/lib/admin';
import type { AdminStation, HealthCheck, StationDraft } from '@/lib/bff';
import { useAdmin } from '../AdminShell';
import { HealthPanel } from './HealthPanel';
import { HistoryPanel } from './HistoryPanel';
import { RightsPanel } from './RightsPanel';
import { isMfaRequired, MfaLink, MFA_NEEDED } from '../MfaPrompt';

type Form = Record<keyof StationDraft, string>;
const FIELDS = Object.keys(FIELD_LABELS).filter((k) => k !== 'reason') as (keyof StationDraft)[];
const EMPTY: Form = {
  name: '',
  country: 'TH',
  language: 'th',
  genres: '',
  streamUrl: 'https://',
  codec: 'mp3',
  bitrateKbps: '',
};

const toForm = (d: StationDraft): Form => ({
  name: d.name,
  country: d.country,
  language: d.language,
  genres: d.genres.join(', '),
  streamUrl: d.streamUrl,
  codec: d.codec,
  bitrateKbps: d.bitrateKbps === null ? '' : String(d.bitrateKbps),
});

/** Turns form strings into the API's types; empty optional fields become null. */
function toDraft(f: Form): StationDraft {
  const n = f.bitrateKbps.trim();
  return {
    name: f.name,
    country: f.country.trim(),
    language: f.language.trim(),
    genres: f.genres.split(',').map((g) => g.trim()).filter(Boolean),
    streamUrl: f.streamUrl.trim(),
    codec: f.codec as StationDraft['codec'],
    bitrateKbps: n === '' ? null : /^\d+$/.test(n) ? Number(n) : (n as unknown as number),
  };
}

const display = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : Array.isArray(v) ? v.join(', ') : String(v));

type Problem = { kind: 'field'; field: string; reason: string } | { kind: 'conflict'; revision: number } | { kind: 'message'; text: string } | { kind: 'mfa' };

export function StationEditor({ station: initial, history = [] }: { station?: AdminStation; history?: HealthCheck[] }) {
  const { csrfToken, canEdit, isAdmin } = useAdmin();
  const router = useRouter();
  const [station, setStation] = useState(initial);
  const [form, setForm] = useState<Form>(initial ? toForm(initial.draft) : EMPTY);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [notice, setNotice] = useState('');
  const [reason, setReason] = useState('');
  const [toggleReason, setToggleReason] = useState('');
  const [emergencyReason, setEmergencyReason] = useState('');
  const [emergencyOk, setEmergencyOk] = useState(false);
  // Bumped after a rights change so the history reloads; the station view is re-read for its blockers.
  const [rightsTick, setRightsTick] = useState(0);
  // Until hydration a click would fall back to a native GET submit and drop the typed values.
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  const alertRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (problem) alertRef.current?.focus();
  }, [problem]);

  const saved = station ? toForm(station.draft) : EMPTY;
  const changed = FIELDS.filter((k) => form[k] !== saved[k]);
  const dirty = changed.length > 0;
  const set = (k: keyof StationDraft) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function call(url: string, method: string, body: unknown, ifMatch?: number): Promise<{ res: Response; body: Record<string, any> } | null> {
    setBusy(true);
    setProblem(null);
    setNotice('');
    try {
      const res = await fetch(url, {
        method,
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken, ...(ifMatch !== undefined ? { 'if-match': `"${ifMatch}"` } : {}) },
        body: JSON.stringify(body),
      });
      return { res, body: await res.json().catch(() => ({})) };
    } catch {
      setProblem({ kind: 'message', text: 'เชื่อมต่อระบบไม่ได้ ยังไม่ได้บันทึก ลองอีกครั้ง' });
      return null;
    } finally {
      setBusy(false);
    }
  }

  function fail(res: Response, body: Record<string, any>) {
    const d = body.details ?? {};
    if (res.status === 400 && d.field) setProblem({ kind: 'field', field: d.field, reason: d.reason });
    else if (res.status === 412) setProblem({ kind: 'conflict', revision: d.currentRevision });
    else if (res.status === 409 && body.code === 'PUBLISH_BLOCKED')
      setProblem({ kind: 'message', text: (d.reasons as string[]).map((r) => BLOCKER_LABELS[r] ?? r).join(' · ') });
    else if (isMfaRequired(res.status, body)) setProblem({ kind: 'mfa' });
    else if (res.status === 401) setProblem({ kind: 'message', text: 'หมดเวลาเข้าใช้งาน กรุณาเข้าสู่ระบบอีกครั้ง' });
    else if (res.status === 403) setProblem({ kind: 'message', text: 'บัญชีนี้ไม่มีสิทธิ์ทำรายการนี้' });
    else if (res.status === 429) setProblem({ kind: 'message', text: `${RATE_LIMITED} ยังไม่ได้บันทึก` });
    else setProblem({ kind: 'message', text: 'ระบบไม่พร้อมใช้งานชั่วคราว ยังไม่ได้บันทึก' });
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const draft = toDraft(form);
    if (!station) {
      const r = await call('/bff/admin/stations', 'POST', draft);
      if (!r) return;
      if (r.res.status === 201) router.push(`/admin/stations/${r.body.id}`);
      else fail(r.res, r.body);
      return;
    }
    const patch = Object.fromEntries(changed.map((k) => [k, draft[k]]));
    const r = await call(`/bff/admin/stations/${station.id}`, 'PATCH', patch, station.revision);
    if (!r) return;
    if (r.res.ok) {
      setStation(r.body as AdminStation);
      setForm(toForm((r.body as AdminStation).draft));
      setNotice(`บันทึกร่างแล้ว · revision ${r.body.revision}`);
      router.refresh();
    } else fail(r.res, r.body);
  }

  async function act(action: 'publish' | 'disable' | 'enable', emergency = false) {
    if (!station) return;
    const why = emergency ? emergencyReason : action === 'publish' ? reason : toggleReason;
    const body = emergency ? { reason: why, emergency: true } : { reason: why };
    const r = await call(`/bff/admin/stations/${station.id}/${action}`, 'POST', body, action === 'publish' ? station.revision : undefined);
    if (!r) return;
    if (r.res.ok) {
      setStation(r.body as AdminStation);
      if (emergency) {
        setEmergencyReason('');
        setEmergencyOk(false);
      } else if (action === 'publish') setReason('');
      else setToggleReason('');
      setNotice(action === 'publish' ? `เผยแพร่ revision ${r.body.revision} แล้ว แอปจะเห็นในการโหลดรายการครั้งถัดไป` : action === 'disable' ? 'ปิดสถานีแล้ว แอปจะไม่เห็นสถานีนี้' : 'เปิดสถานีอีกครั้งแล้ว');
      router.refresh();
    } else fail(r.res, r.body);
  }

  /** Rights records are not part of the draft: re-read the station so its rights summary and blockers follow. */
  async function rightsChanged() {
    if (!station) return;
    setRightsTick((n) => n + 1);
    try {
      const res = await fetch(`/bff/admin/stations/${station.id}`);
      if (res.ok) setStation((await res.json()) as AdminStation);
    } catch {
      // The panel already reported the change; a reload shows the new blockers.
    }
    router.refresh();
  }

  const fieldError = (k: string) =>
    problem?.kind === 'field' && problem.field === k ? REASON_LABELS[problem.reason] ?? problem.reason : null;
  const input = (k: keyof StationDraft, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => {
    const err = fieldError(k);
    return (
      <label className={`fld${err ? ' bad' : ''}`}>
        <span>{FIELD_LABELS[k]}</span>
        <input value={form[k]} onChange={set(k)} disabled={!canEdit} aria-invalid={!!err} aria-describedby={err ? `err-${k}` : undefined} {...props} />
        {err && <em id={`err-${k}`}>{err}</em>}
      </label>
    );
  };

  const diff = station?.published
    ? FIELDS.filter((k) => JSON.stringify(station.published![k]) !== JSON.stringify(station.draft[k]))
    : [];
  const blockers = station ? station.publishBlockers.filter((b) => b !== 'admin_role_required' || !isAdmin) : [];

  return (
    <div className="editor">
      <div className="ed-head">
        <div>
          <p className="crumb">
            <Link href="/admin/stations">สถานีวิทยุ</Link> /
          </p>
          <h2>{station ? station.draft.name : 'เพิ่มสถานี'}</h2>
          {station && (
            <p className="meta">
              <span className={`pill ${station.status}`}>{STATUS_LABELS[station.status]}</span> ร่าง revision {station.revision}
              {station.publishedRevision !== null && ` · เผยแพร่ revision ${station.publishedRevision} เมื่อ ${formatDateTime(station.publishedAt)}`}
            </p>
          )}
        </div>
      </div>

      {problem && (
        <div ref={alertRef} tabIndex={-1} role="alert" className="adm-alert">
          {problem.kind === 'conflict' && (
            <>
              มีคนแก้สถานีนี้ไปก่อนแล้ว (ตอนนี้เป็น revision {problem.revision}) ค่าที่คุณแก้ยังไม่ได้บันทึก{' '}
              <button type="button" className="adm-link" onClick={() => location.reload()}>
                โหลดค่าล่าสุด
              </button>
            </>
          )}
          {problem.kind === 'field' && `${FIELD_LABELS[problem.field] ?? problem.field}: ${REASON_LABELS[problem.reason] ?? problem.reason}`}
          {problem.kind === 'message' && problem.text}
          {problem.kind === 'mfa' && (
            <>
              {MFA_NEEDED} <MfaLink />
            </>
          )}
        </div>
      )}
      <p className={notice ? 'adm-ok' : 'sr-only'} role="status">
        {notice}
      </p>

      <div className="ed-grid">
        <form className="adm-panel" onSubmit={save} aria-label="ข้อมูลสถานี">
          <h3>ข้อมูลสถานี</h3>
          {input('name', { required: true, maxLength: 80 })}
          <div className="row2">
            {input('country', { maxLength: 2, required: true })}
            {input('language', { maxLength: 3, required: true })}
          </div>
          {input('genres', { placeholder: 'jazz, news' })}
          {input('streamUrl', { type: 'url', required: true, inputMode: 'url' })}
          <div className="row2">
            <label className={`fld${fieldError('codec') ? ' bad' : ''}`}>
              <span>{FIELD_LABELS.codec}</span>
              <select value={form.codec} onChange={set('codec')} disabled={!canEdit}>
                <option value="mp3">MP3</option>
                <option value="aac">AAC</option>
                <option value="hls">HLS</option>
              </select>
            </label>
            {input('bitrateKbps', { inputMode: 'numeric' })}
          </div>
          {!station && <p className="dim">สร้างร่างก่อน แล้วเพิ่มหลักฐานสิทธิ์ในหน้าสถานี</p>}
          {canEdit && (
            <div className="ed-actions">
              <button type="submit" className="btn" disabled={!ready || busy || (!!station && !dirty)}>
                {busy ? 'กำลังบันทึก…' : station ? 'บันทึกร่าง' : 'สร้างร่าง'}
              </button>
              {station && <span className="dim">{dirty ? `แก้ไข ${changed.length} ช่อง ยังไม่บันทึก` : 'ไม่มีอะไรเปลี่ยน'}</span>}
            </div>
          )}
        </form>

        {station && (
          <aside className="ed-side">
            {diff.length > 0 && (
              <section className="adm-panel" aria-label="เปลี่ยนจากที่เผยแพร่">
                <h3>
                  เปลี่ยนจาก revision {station.publishedRevision} ที่เผยแพร่อยู่
                </h3>
                <dl className="diff">
                  {diff.map((k) => (
                    <div key={k}>
                      <dt>{FIELD_LABELS[k]}</dt>
                      <dd>
                        <del>{display(station.published![k])}</del> <ins>{display(station.draft[k])}</ins>
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
            )}

            <section className="adm-panel" aria-label="เผยแพร่">
              <h3>เผยแพร่</h3>
              {dirty ? (
                <p className="dim">บันทึกร่างก่อน แล้วให้แอดมินอีกคนตรวจและเผยแพร่</p>
              ) : blockers.length > 0 ? (
                <>
                  <ul className="chk">
                    {blockers.map((b) => (
                      <li key={b}>{BLOCKER_LABELS[b] ?? b}</li>
                    ))}
                  </ul>
                  {/* Doc 17 emergency exception: only when the sole blocker is that this admin made the change. */}
                  {isAdmin && blockers.length === 1 && blockers[0] === 'own_change' && (
                    <details className="emergency">
                      <summary>กรณีฉุกเฉิน: เผยแพร่โดยไม่มีแอดมินคนที่สอง</summary>
                      <p className="dim">
                        ใช้เมื่อรอแอดมินคนอื่นไม่ได้ เช่น ลิงก์สตรีมเสียและผู้ฟังเล่นไม่ได้ ต้องยืนยัน MFA ภายใน 5 นาที
                        รายการนี้บันทึกใน audit แยกเป็น “เผยแพร่แบบฉุกเฉิน” เพื่อให้ทีมตรวจย้อนหลัง
                      </p>
                      <label className="fld">
                        <span>เหตุผลที่ต้องเผยแพร่ทันที (อย่างน้อย 20 ตัวอักษร)</span>
                        <textarea value={emergencyReason} onChange={(e) => setEmergencyReason(e.target.value)} maxLength={500} rows={2} />
                      </label>
                      <label className="fld check">
                        <input type="checkbox" checked={emergencyOk} onChange={(e) => setEmergencyOk(e.target.checked)} />
                        <span>ฉันตรวจร่างนี้แล้ว และเข้าใจว่าไม่มีผู้ตรวจคนที่สอง</span>
                      </label>
                      <button
                        type="button"
                        className="btn danger"
                        disabled={busy || !emergencyOk || emergencyReason.trim().length < 20}
                        onClick={() => act('publish', true)}
                      >
                        เผยแพร่ฉุกเฉิน revision {station.revision}
                      </button>
                    </details>
                  )}
                </>
              ) : (
                <>
                  <ul className="chk ok">
                    <li>มีหลักฐานสิทธิ์ที่ใช้งานอยู่และครอบคลุมประเทศ {station.draft.country}</li>
                    <li>คุณไม่ได้แก้ร่างนี้เอง</li>
                  </ul>
                  <label className="fld">
                    <span>เหตุผลที่เผยแพร่ (บันทึกใน audit)</span>
                    <textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} rows={2} />
                  </label>
                  <button type="button" className="btn" disabled={busy || !reason.trim()} onClick={() => act('publish')}>
                    เผยแพร่ revision {station.revision}
                  </button>
                </>
              )}
            </section>

            <RightsPanel station={station} onChanged={rightsChanged} />

            {/* From props, not local state, so a refresh after "check now" shows the new result. */}
            <HealthPanel station={initial ?? station} history={history} />

            {isAdmin && station.publishedRevision !== null && (
              <section className="adm-panel" aria-label="เปิดหรือปิดสถานี">
                <h3>{station.disabledAt ? 'สถานีถูกปิดอยู่' : 'ปิดสถานีชั่วคราว'}</h3>
                <p className="dim">
                  {station.disabledAt ? `ปิดเมื่อ ${formatDateTime(station.disabledAt)} แอปมองไม่เห็นสถานีนี้` : 'แอปจะไม่เห็นสถานีนี้จนกว่าจะเปิดอีกครั้ง'}
                </p>
                <label className="fld">
                  <span>{station.disabledAt ? 'เหตุผลที่เปิด' : 'เหตุผลที่ปิด'} (บันทึกใน audit)</span>
                  <textarea value={toggleReason} onChange={(e) => setToggleReason(e.target.value)} maxLength={500} rows={2} />
                </label>
                <button type="button" className="btn secondary" disabled={busy || !toggleReason.trim()} onClick={() => act(station.disabledAt ? 'enable' : 'disable')}>
                  {station.disabledAt ? 'เปิดสถานีอีกครั้ง' : 'ปิดสถานี'}
                </button>
              </section>
            )}

            <HistoryPanel stationId={station.id} refreshKey={`${station.revision}-${station.publishedRevision}-${station.disabledAt}-${rightsTick}`} />
          </aside>
        )}
      </div>
    </div>
  );
}
