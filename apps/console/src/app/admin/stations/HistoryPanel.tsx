'use client';

import { useEffect, useState } from 'react';
import { actionLabel, formatDateTime } from '@/lib/admin';
import type { StationHistoryEntry } from '@/lib/bff';

/**
 * Version history of one station from the audit trail: edits, publishes, disables and rights changes, newest first.
 * `refreshKey` changes after each change made on this page, so the list reloads from the first page.
 */
export function HistoryPanel({ stationId, refreshKey }: { stationId: string; refreshKey: string }) {
  const [events, setEvents] = useState<StationHistoryEntry[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  async function load(after: string | null) {
    setBusy(true);
    try {
      const res = await fetch(`/bff/admin/stations/${stationId}/history?limit=50${after ? `&cursor=${encodeURIComponent(after)}` : ''}`);
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as { events: StationHistoryEntry[]; nextCursor: string | null };
      setEvents((prev) => (after && prev ? [...prev, ...body.events] : body.events));
      setCursor(body.nextCursor);
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void load(null);
  }, [stationId, refreshKey]);

  return (
    <section className="adm-panel" aria-label="ประวัติเวอร์ชัน">
      <h3>ประวัติเวอร์ชัน</h3>
      {failed && <p className="adm-alert">โหลดประวัติไม่ได้ ลองโหลดหน้าใหม่</p>}
      {events && events.length === 0 && <p className="dim">ยังไม่มีประวัติ</p>}
      {events && events.length > 0 && (
        <ol className="rt-history">
          {events.map((e) => (
            <li key={e.id}>
              <span className="mono">{e.revision !== null ? `r${e.revision}` : '—'}</span>
              <span>{actionLabel(e.action)}</span>
              <small>
                {e.actorSubject ?? e.actor} · {formatDateTime(e.occurredAt)}
                {e.reason && ` · ${e.reason}`}
              </small>
            </li>
          ))}
        </ol>
      )}
      {cursor && (
        <button type="button" className="btn secondary" disabled={busy} onClick={() => load(cursor)}>
          {busy ? 'กำลังโหลด…' : 'โหลดเพิ่ม'}
        </button>
      )}
    </section>
  );
}
