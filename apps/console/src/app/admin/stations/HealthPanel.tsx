'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { formatDateTime, HEALTH_LABELS, probeReason, RATE_LIMITED } from '@/lib/admin';
import type { AdminStation, HealthCheck } from '@/lib/bff';
import { useAdmin } from '../AdminShell';

/**
 * Stream health for one station: the scheduled checks per region, a "check now" button for
 * catalog staff and the recent history. A suspect station is never disabled automatically.
 */
export function HealthPanel({ station, history }: { station: AdminStation; history: HealthCheck[] }) {
  const { csrfToken, canEdit } = useAdmin();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  const health = station.health ?? { state: 'unknown', regions: [] };
  const live = station.publishedRevision !== null;

  async function checkNow() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`/bff/admin/stations/${station.id}/check`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: '{}',
      });
      const body = (await res.json().catch(() => ({}))) as Partial<HealthCheck> & { code?: string };
      if (res.status === 429 && body.code === 'API_RATE_LIMITED') setMessage({ ok: false, text: RATE_LIMITED });
      else if (res.ok) {
        setMessage({ ok: !!body.ok, text: body.ok ? `เล่นได้ · ${body.latencyMs} ms` : `ตรวจไม่ผ่าน · ${probeReason(body.reason ?? '', body.httpStatus ?? null)}` });
        router.refresh();
      } else if (res.status === 429) setMessage({ ok: false, text: 'เพิ่งตรวจไปไม่ถึงนาที รอสักครู่แล้วลองใหม่' });
      else if (res.status === 401) setMessage({ ok: false, text: 'หมดเวลาเข้าใช้งาน กรุณาเข้าสู่ระบบอีกครั้ง' });
      else if (res.status === 403) setMessage({ ok: false, text: 'บัญชีนี้ไม่มีสิทธิ์ตรวจสตรีม' });
      else setMessage({ ok: false, text: 'ตรวจไม่ได้ในขณะนี้ ลองอีกครั้ง' });
    } catch {
      setMessage({ ok: false, text: 'เชื่อมต่อระบบไม่ได้ ลองอีกครั้ง' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="adm-panel hl-panel" aria-label="สุขภาพสตรีม">
      <h3>สตรีมเล่นได้ไหม</h3>
      <p className="hl-state">
        <span className={`hl-pill ${health.state}`}>
          <i className={`hl-dot ${health.state}`} aria-hidden="true" />
          {HEALTH_LABELS[health.state]}
        </span>
        {health.state === 'unknown' && <span className="dim">{live ? 'ระบบตรวจสตรีมที่เผยแพร่เป็นรอบ ๆ ยังไม่มีผลตั้งแต่เผยแพร่ครั้งล่าสุด' : 'ยังไม่เผยแพร่ ระบบจะเริ่มตรวจหลังเผยแพร่'}</span>}
      </p>
      {health.state === 'suspect' && (
        <p className="hl-note" role="note">
          ตรวจไม่ผ่านติดกัน 3 ครั้ง ระบบไม่ปิดสถานีเอง ให้แอดมินดูว่าควรแก้ที่อยู่สตรีมหรือปิดสถานีชั่วคราว
        </p>
      )}
      {health.regions.length > 0 && (
        <dl className="hl-regions">
          {health.regions.map((r) => (
            <div key={r.region}>
              <dt>
                <i className={`hl-dot ${r.state}`} aria-hidden="true" />
                {r.region}
              </dt>
              <dd>
                {probeReason(r.reason, r.httpStatus)}
                {r.latencyMs !== null && r.state === 'ok' && ` · ${r.latencyMs} ms`}
                {r.consecutiveFailures > 0 && ` · ไม่ผ่าน ${r.consecutiveFailures} ครั้งติด`}
                <small>ตรวจล่าสุด {formatDateTime(r.checkedAt)}</small>
              </dd>
            </div>
          ))}
        </dl>
      )}
      {canEdit && (
        <div className="hl-actions">
          <button type="button" className="btn secondary" disabled={!ready || busy} onClick={checkNow}>
            {busy ? 'กำลังตรวจ…' : live ? 'ตรวจตอนนี้' : 'ตรวจสตรีมของร่าง'}
          </button>
          <span className="dim">ดูแค่ส่วนหัวและข้อมูลช่วงแรก ไม่เกิน 10 วินาที</span>
        </div>
      )}
      <p className={message ? (message.ok ? 'adm-ok' : 'adm-alert') : 'sr-only'} role="status">
        {message?.text}
      </p>
      {history.length > 0 && (
        <details className="hl-history">
          <summary>ประวัติการตรวจ {history.length} ครั้งล่าสุด</summary>
          <ol>
            {history.map((c, i) => (
              <li key={`${c.checkedAt}-${i}`} className={c.ok ? 'ok' : 'bad'}>
                <span className="mono">{formatDateTime(c.checkedAt)}</span>
                <span>{c.ok ? '✓' : '✗'} {probeReason(c.reason, c.httpStatus)}</span>
                <small>
                  {c.region} · {c.target === 'draft' ? 'ร่าง' : 'เผยแพร่'}
                  {c.ok && c.latencyMs !== null && ` · ${c.latencyMs} ms`}
                </small>
              </li>
            ))}
          </ol>
        </details>
      )}
    </section>
  );
}
