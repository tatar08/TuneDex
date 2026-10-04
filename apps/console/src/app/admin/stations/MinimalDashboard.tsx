'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import {
  countByHealth,
  countByStatus,
  FIELD_LABELS,
  RATE_LIMITED,
  FILTER_LABELS,
  formatDate,
  formatDateTime,
  HEALTH_LABELS,
  healthLine,
  healthOf,
  initials,
  isLive,
  REASON_LABELS,
  rightsDaysLeft,
  rightsLine,
  rightsSoon,
  STATUS_FILTERS,
  STATUS_LABELS,
  StatusFilter,
  subtitle,
  summarize,
} from '@/lib/admin';
import type { AdminStation } from '@/lib/bff';
import { Icon, useAdmin } from '../AdminShell';

const href = (s: AdminStation) => `/admin/stations/${s.id}`;
const filterHref = (f: StatusFilter, q: string) => {
  const p = new URLSearchParams();
  if (f !== 'all') p.set('status', f);
  if (q) p.set('q', q);
  const qs = p.toString();
  return qs ? `/admin/stations?${qs}` : '/admin/stations';
};
const STATUS_COLORS: Record<AdminStation['status'], string> = {
  published: 'var(--ok)',
  changes_pending: 'var(--w)',
  draft: 'var(--u)',
  disabled: 'var(--e)',
};
const RIGHTS_WINDOW_DAYS = 90;

/** Quick draft from the dashboard: name and stream only; the rest is filled in on the station page. */
function QuickAdd() {
  const { csrfToken, canEdit } = useAdmin();
  const router = useRouter();
  const [name, setName] = useState('');
  const [streamUrl, setStreamUrl] = useState('https://');
  const [codec, setCodec] = useState('mp3');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);

  if (!canEdit) return <p className="fv-muted">บัญชีนี้ดูได้อย่างเดียว</p>;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/bff/admin/stations', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ name, streamUrl: streamUrl.trim(), codec, country: 'TH', language: 'th' }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.status === 201) router.push(href(body as AdminStation));
      else if (res.status === 400 && body.details?.field)
        setError(`${FIELD_LABELS[body.details.field] ?? body.details.field}: ${REASON_LABELS[body.details.reason] ?? body.details.reason}`);
      else setError(res.status === 401 ? 'หมดเวลาเข้าใช้งาน กรุณาเข้าสู่ระบบอีกครั้ง' : res.status === 429 ? RATE_LIMITED : 'สร้างไม่สำเร็จ ลองอีกครั้ง');
    } catch {
      setError('เชื่อมต่อระบบไม่ได้ ลองอีกครั้ง');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="fv-quick" onSubmit={submit}>
      <label>
        <span>ชื่อสถานี</span>
        <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} placeholder="เช่น Bangkok Jazz 24" />
      </label>
      <label>
        <span>ลิงก์สตรีม</span>
        <input type="url" value={streamUrl} onChange={(e) => setStreamUrl(e.target.value)} required inputMode="url" />
      </label>
      <label>
        <span>รูปแบบเสียง</span>
        <select value={codec} onChange={(e) => setCodec(e.target.value)}>
          <option value="mp3">MP3</option>
          <option value="aac">AAC</option>
          <option value="hls">HLS</option>
        </select>
      </label>
      {error && (
        <p className="fv-error" role="alert">
          {error}
        </p>
      )}
      <button type="submit" className="fv-dark" disabled={!ready || busy}>
        {busy ? 'กำลังสร้าง…' : 'สร้างร่างแล้วกรอกต่อ'}
      </button>
      <p className="fv-muted">ประเทศและภาษาเริ่มที่ TH / ไทย แก้ได้ในหน้าถัดไป</p>
    </form>
  );
}

function Donut({ stations }: { stations: AdminStation[] }) {
  const c = countByStatus(stations);
  const order: AdminStation['status'][] = ['published', 'changes_pending', 'draft', 'disabled'];
  let at = 0;
  const stops = order
    .filter((k) => c[k] > 0)
    .map((k) => {
      const from = at;
      at += (c[k] / Math.max(c.all, 1)) * 360;
      return `${STATUS_COLORS[k]} ${from}deg ${at}deg`;
    });
  const pct = (k: AdminStation['status']) => (c.all ? Math.round((c[k] / c.all) * 100) : 0);
  return (
    <>
      <div className="fv-donut" style={{ background: stops.length ? `conic-gradient(${stops.join(', ')})` : 'var(--line)' }} role="img" aria-label={order.map((k) => `${STATUS_LABELS[k]} ${c[k]}`).join(', ')}>
        <span>
          <small>ทั้งหมด</small>
          <b>{c.all}</b>
        </span>
      </div>
      <ul className="fv-legend">
        {order.map((k) => (
          <li key={k} style={{ ['--c' as string]: STATUS_COLORS[k] }}>
            {STATUS_LABELS[k]} {pct(k)}%
          </li>
        ))}
      </ul>
    </>
  );
}

export function MinimalDashboard({ stations, filter, query }: { stations: AdminStation[]; filter: StatusFilter; query: string }) {
  const { canEdit } = useAdmin();
  const sum = useMemo(() => summarize(stations), [stations]);
  const counts = useMemo(() => countByStatus(stations), [stations]);
  const needsReview = stations
    .filter((s) => s.status === 'changes_pending' || s.status === 'draft')
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const firstPending = stations.find((s) => s.status === 'changes_pending');
  const expiring = stations
    .map((s) => ({ s, days: rightsDaysLeft(s) }))
    .filter((x): x is { s: AdminStation; days: number } => x.days !== null && x.days <= RIGHTS_WINDOW_DAYS && x.s.status !== 'disabled')
    .sort((a, b) => a.days - b.days);
  const lastPublished = stations
    .map((s) => s.publishedAt)
    .filter((d): d is string => !!d)
    .sort()
    .pop();
  const health = useMemo(() => countByHealth(stations), [stations]);
  const unhealthy = stations
    .filter((s) => isLive(s) && (healthOf(s).state === 'suspect' || healthOf(s).state === 'failing'))
    .sort((a, b) => Number(healthOf(b).state === 'suspect') - Number(healthOf(a).state === 'suspect'));
  const shown = stations
    .filter((s) => filter === 'all' || s.status === filter)
    .filter((s) => !query || s.draft.name.toLowerCase().includes(query.toLowerCase()));

  return (
    <div className="fv-dash">
      <div className="fv-grid">
        {/* Left column */}
        <div className="fv-col left">
          <section className="fv-card" aria-labelledby="fv-review">
            <div className="fv-card-head">
              <h2 id="fv-review">รอตรวจล่าสุด</h2>
              <Link href={filterHref('changes_pending', '')}>ดูทั้งหมด</Link>
            </div>
            {needsReview.length === 0 ? (
              <p className="fv-muted">ไม่มีงานรอตรวจ</p>
            ) : (
              <ul className="fv-tx">
                {needsReview.slice(0, 4).map((s) => (
                  <li key={s.id}>
                    <span className={`fv-tile ${s.status}`} aria-hidden="true">
                      {initials(s.draft.name)}
                    </span>
                    <Link href={href(s)} className="fv-tx-main">
                      <b>{s.draft.name}</b>
                      <small>
                        {formatDateTime(s.updatedAt)} · r{s.revision}
                      </small>
                    </Link>
                    <span className="fv-tx-side">
                      <b className={`st ${s.status}`}>{STATUS_LABELS[s.status]}</b>
                      <small>{s.publishedRevision ? `เผยแพร่ r${s.publishedRevision}` : 'ยังไม่เคยเผยแพร่'}</small>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="fv-card" aria-labelledby="fv-rights">
            <div className="fv-card-head">
              <div>
                <h2 id="fv-rights">สิทธิ์ใกล้หมดอายุ</h2>
                <small>ภายใน {RIGHTS_WINDOW_DAYS} วัน หลังหมดอายุแอปจะไม่เห็นสถานีเอง</small>
              </div>
              <span className="fv-accent">{expiring.length} รายการ</span>
            </div>
            {expiring.length === 0 ? (
              <p className="fv-muted">ไม่มีสิทธิ์ที่ใกล้หมดอายุ</p>
            ) : (
              <ul className="fv-pots">
                {expiring.slice(0, 4).map(({ s, days }) => (
                  <li key={s.id}>
                    <div className="fv-pot-row">
                      <Link href={href(s)}>{s.draft.name}</Link>
                      <b>{formatDate(s.draft.rightsExpiresAt)}</b>
                    </div>
                    <div className="fv-bar" aria-hidden="true">
                      <i style={{ width: `${Math.max(0, Math.min(100, (days / RIGHTS_WINDOW_DAYS) * 100))}%` }} className={days <= 14 ? 'hot' : undefined} />
                    </div>
                    <div className="fv-pot-row small">
                      <span>{s.draft.rightsReference ?? 'ไม่มีเลขอ้างอิง'}</span>
                      <span className={days <= 14 ? 'hot' : undefined}>{days < 0 ? 'หมดแล้ว' : `เหลือ ${days} วัน`}</span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {canEdit && (
              <Link href="/admin/stations/new" className="fv-dark">
                + เพิ่มสถานี
              </Link>
            )}
          </section>
          <section className="fv-card" aria-labelledby="fv-health">
            <div className="fv-card-head">
              <div>
                <h2 id="fv-health">สตรีมที่ต้องดู</h2>
                <small>ผลตรวจสตรีมของสถานีที่แอปเห็น ระบบไม่ปิดสถานีเอง</small>
              </div>
              <span className={health.suspect ? 'fv-accent' : 'fv-muted'}>{health.suspect + health.failing} สถานี</span>
            </div>
            <ul className="fv-health" aria-label="สรุปผลตรวจ">
              {(['ok', 'failing', 'suspect', 'unknown'] as const).map((k) => (
                <li key={k} className={k}>
                  <b>{health[k]}</b>
                  <small>{HEALTH_LABELS[k]}</small>
                </li>
              ))}
            </ul>
            {unhealthy.length === 0 ? (
              <p className="fv-muted">{health.ok ? 'ทุกสถานีที่ตรวจแล้วเล่นได้' : 'ยังไม่มีผลตรวจ'}</p>
            ) : (
              <ul className="fv-tx">
                {unhealthy.slice(0, 4).map((s) => (
                  <li key={s.id}>
                    <span className={`fv-tile hl-${healthOf(s).state}`} aria-hidden="true">
                      {initials(s.draft.name)}
                    </span>
                    <Link href={href(s)} className="fv-tx-main">
                      <b>{s.draft.name}</b>
                      <small>{healthLine(healthOf(s))}</small>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        {/* Middle column */}
        <div className="fv-col mid">
          <section className="fv-card" aria-labelledby="fv-visible">
            <div className="fv-card-head">
              <div>
                <small className="fv-label" id="fv-visible">
                  สถานีที่แอปเห็นตอนนี้
                </small>
                <p className="fv-big">
                  <span>{sum.visible}</span> สถานี
                </p>
              </div>
            </div>
            <div className="fv-hero">
              <div className="fv-hero-top">
                <span className="fv-hero-logo" aria-hidden="true">
                  <Icon name="radio" />
                </span>
                <div>
                  <b>TUNEDECK CATALOG</b>
                  <small>แค็ตตาล็อกสาธารณะสำหรับแอป</small>
                </div>
              </div>
              <div>
                <small>สถานีทั้งหมดในระบบ</small>
                <p className="fv-hero-num">{String(sum.total).padStart(3, '0')}</p>
              </div>
              <div className="fv-hero-foot">
                <div>
                  <small>เผยแพร่ล่าสุด</small>
                  <b>{lastPublished ? formatDateTime(lastPublished) : 'ยังไม่มี'}</b>
                </div>
                <div className="r">
                  <small>ปิดอยู่</small>
                  <b>{sum.disabled} สถานี</b>
                </div>
              </div>
            </div>
            <div className="fv-hero-actions">
              <Link href={filterHref('published', '')} className="fv-ghost">
                ดูสถานีที่เผยแพร่
              </Link>
              <Link href={filterHref('disabled', '')} className="fv-ghost teal">
                ดูสถานีที่ปิดอยู่
              </Link>
            </div>
          </section>

          <div className="fv-pair">
            <section className="fv-card rose" aria-labelledby="fv-pending">
              <div className="fv-card-head">
                <h2 id="fv-pending">งานรอตรวจ</h2>
                {sum.pending > 0 && <span className="fv-chip">ต้องใช้แอดมินอีกคน</span>}
              </div>
              <small>แอดมินที่ไม่ได้แก้ร่างเป็นผู้เผยแพร่</small>
              <p className="fv-amount">{sum.pending} สถานี</p>
              {firstPending ? (
                <Link href={href(firstPending)} className="fv-red">
                  ตรวจรายการถัดไป →
                </Link>
              ) : (
                <span className="fv-red off">ไม่มีงานค้าง</span>
              )}
            </section>
            <section className="fv-card" aria-labelledby="fv-drafts">
              <div className="fv-card-head">
                <h2 id="fv-drafts">ร่างที่ยังไม่เคยเผยแพร่</h2>
              </div>
              <small>ยังไม่อยู่ในแอป</small>
              <p className="fv-amount">{sum.drafts} ร่าง</p>
              <Link href={filterHref('draft', '')} className="fv-outline">
                ดูร่างทั้งหมด
              </Link>
            </section>
          </div>
        </div>

        {/* Right column */}
        <div className="fv-col right">
          <section className="fv-card" aria-labelledby="fv-quick">
            <div className="fv-card-head">
              <h2 id="fv-quick">เพิ่มสถานีด่วน</h2>
            </div>
            <QuickAdd />
          </section>
          <section className="fv-card" aria-labelledby="fv-mix">
            <div className="fv-card-head">
              <h2 id="fv-mix">สถานะแค็ตตาล็อก</h2>
              <b>{sum.total}</b>
            </div>
            <Donut stations={stations} />
          </section>
        </div>
      </div>

      <section className="fv-card fv-list" aria-labelledby="fv-all">
        <div className="fv-card-head">
          <h2 id="fv-all">รายการสถานี{query && <small> · ค้นหา “{query}”</small>}</h2>
          <nav className="fv-tabs" aria-label="กรองตามสถานะ">
            {STATUS_FILTERS.map((f) => (
              <Link key={f} href={filterHref(f, query)} className={f === filter ? 'on' : undefined} aria-current={f === filter ? 'true' : undefined}>
                {FILTER_LABELS[f]} {counts[f]}
              </Link>
            ))}
          </nav>
        </div>
        {shown.length === 0 ? (
          <p className="fv-muted">{query ? `ไม่พบสถานีชื่อ “${query}”` : filter === 'all' ? 'ยังไม่มีสถานี' : `ไม่มีสถานีที่${FILTER_LABELS[filter]}`}</p>
        ) : (
          <ul className="fv-rows">
            {shown.map((s) => (
              <li key={s.id}>
                <span className={`fv-tile ${s.status}`} aria-hidden="true">
                  {initials(s.draft.name)}
                </span>
                <Link href={href(s)} className="nm">
                  {s.draft.name}
                </Link>
                <small>{subtitle(s)}</small>
                <span className={`st ${s.status}`}>{STATUS_LABELS[s.status]}</span>
                {isLive(s) ? (
                  <small className={`hl-line ${healthOf(s).state}`} title={healthLine(healthOf(s))}>
                    <i className={`hl-dot ${healthOf(s).state}`} aria-hidden="true" />
                    {HEALTH_LABELS[healthOf(s).state]}
                  </small>
                ) : (
                  <small>—</small>
                )}
                <small className={rightsSoon(s) ? 'hot' : undefined}>{rightsLine(s)}</small>
                <small className="mono">r{s.revision}</small>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
