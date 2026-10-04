'use client';

import { useState } from 'react';
import { formatLogTime, RATE_LIMITED } from '@/lib/admin';
import type { IncidentCode, Overview, OverviewWindow } from '@/lib/bff';
import { Icon, useAdmin } from '../AdminShell';

/**
 * Operations overview (Doc 17 /admin/overview): API traffic and errors, catalog health and the background
 * queues for one window. Every figure shows its sample size, and a quiet system reads "stale", not "healthy".
 * Data is shared; each theme lays the page out its own way (Tar, 2026-10-03). Read-only.
 */
const WINDOWS: { id: OverviewWindow; label: string }[] = [
  { id: '1h', label: '1 ชั่วโมง' },
  { id: '24h', label: '24 ชั่วโมง' },
  { id: '7d', label: '7 วัน' },
];

const INCIDENTS: Record<IncidentCode, { title: string; detail: (n: number) => string; href?: string }> = {
  api_error_rate: { title: 'API ตอบ error บ่อย', detail: (n) => `${n} คำขอจบด้วย 5xx เกิน 5% ของทั้งหมด`, href: '/admin/logs?severity=ERROR' },
  account_deletion_failed: { title: 'ลบบัญชีไม่สำเร็จ', detail: (n) => `${n} คำขอกำลังลองใหม่อัตโนมัติ ดูบันทึก ACCOUNT_PURGE_FAILED`, href: '/admin/logs?eventCode=ACCOUNT_PURGE_FAILED' },
  account_deletion_late: { title: 'ลบบัญชีใกล้เกินกำหนด 30 วัน', detail: (n) => `${n} คำขอค้างนานกว่า 25 วัน` },
  account_deletion_stuck: { title: 'คิวลบบัญชีค้าง', detail: (n) => `${n} คำขอยังไม่เริ่มลบหลังผ่านไป 5 นาที`, href: '/admin/jobs' },
  api_latency: { title: 'API ตอบช้า', detail: (n) => `p95 ${n.toLocaleString('th-TH')} ms เกิน 1 วินาที ใน 10 นาทีล่าสุด`, href: '/admin/logs' },
  stations_suspect: { title: 'สถานีน่าสงสัย', detail: (n) => `${n} สถานีตรวจไม่ผ่าน 3 ครั้งติด รอแอดมินตรวจ`, href: '/admin/stations' },
  station_checker_stale: { title: 'ตัวตรวจสตรีมไม่ได้รัน', detail: () => 'ไม่มีผลตรวจใหม่นานเกิน 2.5 รอบ' },
  no_recent_traffic: { title: 'ไม่มีคำขอเข้ามาเลย', detail: () => 'ไม่มีคำขอใน 15 นาทีล่าสุด ตัวเลขอาจไม่ใช่สถานะตอนนี้' },
};

/** An open alert also says since when (Doc 17 rules, checked every minute). */
const detailOf = (i: Overview['incidents'][number]) => INCIDENTS[i.code].detail(i.count) + (i.since ? ` · ตั้งแต่ ${formatLogTime(i.since)}` : '');

const pct = (r: number | null) => (r === null ? '—' : `${(r * 100).toFixed(r < 0.1 ? 1 : 0)}%`);
const ms = (v: number | null) => (v === null ? '—' : v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${v} ms`);
const num = (v: number) => v.toLocaleString('th-TH');
const winLabel = (w: OverviewWindow) => WINDOWS.find((x) => x.id === w)!.label;
const tick = (iso: string, w: OverviewWindow) =>
  new Intl.DateTimeFormat('th-TH', { timeZone: 'Asia/Bangkok', ...(w === '7d' ? { day: 'numeric', month: 'short' } : { hour: '2-digit', minute: '2-digit' }) }).format(new Date(iso));

function WindowPicker({ window, className }: { window: OverviewWindow; className: string }) {
  return (
    <nav className={className} aria-label="ช่วงเวลา">
      {WINDOWS.map((w) => (
        <a key={w.id} href={w.id === '24h' ? '/admin/overview' : `/admin/overview?window=${w.id}`} className={w.id === window ? 'on' : undefined} aria-current={w.id === window ? 'true' : undefined}>
          {w.label}
        </a>
      ))}
    </nav>
  );
}

/**
 * Requests per bucket, stacked: successful/4xx below, 5xx on top, on one shared scale (no second axis).
 * Each bar has a hover/focus tooltip, and a table carries the same numbers for screen readers.
 */
function TrafficChart({ o, height = 140 }: { o: Overview; height?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const b = o.api.buckets;
  const max = Math.max(1, ...b.map((x) => x.requests));
  const W = 600;
  const slot = W / b.length;
  const bar = Math.max(2, slot - 2);
  const y = (v: number) => (v / max) * (height - 4);
  const h = hover === null ? null : b[hover];
  return (
    <figure className="ov-chart">
      <div className="ov-legend" aria-hidden="true">
        <span>
          <i className="ok" /> สำเร็จและ 4xx
        </span>
        <span>
          <i className="err" /> 5xx
        </span>
        <span className="dim">สูงสุด {num(max)} คำขอต่อช่อง</span>
      </div>
      <div className="ov-plot">
        <svg viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none" role="img" aria-label={`คำขอ API ใน ${winLabel(o.window.id)} ล่าสุด แยกช่องละช่วงเวลา`}>
          <line x1="0" x2={W} y1={height - 0.5} y2={height - 0.5} className="ov-base" />
          {b.map((x, i) => {
            const good = x.requests - x.serverErrors;
            const hg = y(good);
            const he = y(x.serverErrors);
            const left = i * slot + (slot - bar) / 2;
            return (
              <g key={x.at} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
                <rect x={i * slot} y={0} width={slot} height={height} fill="transparent" />
                {good > 0 && <rect className="ok" x={left} y={height - hg} width={bar} height={hg} rx={Math.min(2, bar / 2)} />}
                {x.serverErrors > 0 && <rect className="err" x={left} y={height - hg - he - (good > 0 ? 2 : 0)} width={bar} height={he} rx={Math.min(2, bar / 2)} />}
              </g>
            );
          })}
        </svg>
        {h && (
          <div className="ov-tip" role="status" style={{ left: `${((hover! + 0.5) / b.length) * 100}%` }}>
            <b>{tick(h.at, o.window.id)}</b>
            <span>{num(h.requests)} คำขอ</span>
            <span>5xx {num(h.serverErrors)}</span>
            <span>p95 {ms(h.p95Ms)}</span>
          </div>
        )}
      </div>
      <div className="ov-axis dim" aria-hidden="true">
        <span>{tick(o.window.from, o.window.id)}</span>
        <span>ตอนนี้</span>
      </div>
      <table className="sr-only">
        <caption>คำขอ API ต่อช่วงเวลา</caption>
        <thead>
          <tr>
            <th scope="col">เริ่ม</th>
            <th scope="col">คำขอ</th>
            <th scope="col">5xx</th>
            <th scope="col">p95</th>
          </tr>
        </thead>
        <tbody>
          {b.map((x) => (
            <tr key={x.at}>
              <td>{tick(x.at, o.window.id)}</td>
              <td>{x.requests}</td>
              <td>{x.serverErrors}</td>
              <td>{ms(x.p95Ms)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

function Incidents({ o, className }: { o: Overview; className: string }) {
  if (o.incidents.length === 0) {
    return (
      <p className="ov-calm">
        <span className="ov-sev ok" aria-hidden="true">✓</span> ไม่มีเรื่องที่ต้องดูตอนนี้
      </p>
    );
  }
  return (
    <ul className={className} aria-label="เรื่องที่ต้องดู">
      {o.incidents.map((i) => {
        const d = INCIDENTS[i.code];
        return (
          <li key={i.code} className={i.severity}>
            <span className={`ov-sev ${i.severity}`} aria-hidden="true">
              {i.severity === 'critical' ? '!' : '•'}
            </span>
            <span className="ov-inc">
              <b>
                <span className="sr-only">{i.severity === 'critical' ? 'วิกฤต: ' : 'เตือน: '}</span>
                {d.title}
              </b>
              <small>{detailOf(i)}</small>
            </span>
            {d.href && (
              <a href={d.href} className="adm-link">
                ดู
              </a>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** The headline figures, each with the sample it comes from. */
function kpis(o: Overview) {
  const h = o.stations.health;
  return [
    { id: 'req', label: 'คำขอ API', value: num(o.api.requests), sub: o.api.stale ? 'ไม่มีคำขอใน 15 นาทีล่าสุด' : `ล่าสุด ${o.api.lastRequestAt ? formatLogTime(o.api.lastRequestAt) : '—'}`, warn: o.api.stale },
    {
      id: 'err',
      label: 'อัตรา 5xx',
      value: pct(o.api.errorRate),
      sub: o.api.requests < 50 ? `จาก ${num(o.api.requests)} คำขอ ยังน้อยเกินจะสรุป` : `${num(o.api.serverErrors)} จาก ${num(o.api.requests)} คำขอ`,
      warn: o.incidents.some((i) => i.code === 'api_error_rate'),
    },
    { id: 'lat', label: 'เวลาตอบ p95', value: ms(o.api.p95Ms), sub: `ค่ากลาง ${ms(o.api.p50Ms)}`, warn: false },
    {
      id: 'st',
      label: 'สถานีที่เปิดอยู่',
      value: num(o.stations.published),
      sub: `เล่นได้ ${h.ok} · ไม่ผ่าน ${h.failing} · น่าสงสัย ${h.suspect} · ยังไม่ตรวจ ${h.unknown}`,
      warn: h.suspect > 0,
    },
    {
      id: 'del',
      label: 'คิวลบบัญชี',
      value: num(o.queues.accountDeletions.open),
      sub: o.queues.accountDeletions.failed ? `ไม่สำเร็จ ${o.queues.accountDeletions.failed} · ต้องเสร็จใน ${o.queues.accountDeletions.deadlineDays} วัน` : `ต้องเสร็จใน ${o.queues.accountDeletions.deadlineDays} วัน`,
      warn: o.queues.accountDeletions.failed > 0,
    },
  ];
}

function Footnote({ o }: { o: Overview }) {
  return (
    <p className="ov-foot dim">
      ข้อมูล {winLabel(o.window.id)} ถึง {formatLogTime(o.generatedAt)} · ตัวตรวจสตรีม{' '}
      {o.stations.checkerEnabled ? `เปิดอยู่ ผลล่าสุด ${o.stations.lastCheckAt ? formatLogTime(o.stations.lastCheckAt) : 'ยังไม่มี'}` : 'ปิดอยู่ (STATION_CHECK_ENABLED)'} · รายงานวินิจฉัย {num(o.queues.diagnosticReports)} ฉบับ · ตัวเลขรวมเท่านั้น ไม่มีข้อมูลรายคน
    </p>
  );
}

function TopErrors({ o }: { o: Overview }) {
  if (o.api.topErrors.length === 0) return <p className="dim">ไม่มี 5xx ในช่วงนี้</p>;
  return (
    <table className="ov-errors">
      <caption className="sr-only">เส้นทางที่ตอบ 5xx บ่อยสุด</caption>
      <thead>
        <tr>
          <th scope="col">เส้นทาง</th>
          <th scope="col">สถานะ</th>
          <th scope="col">ครั้ง</th>
        </tr>
      </thead>
      <tbody>
        {o.api.topErrors.map((e) => (
          <tr key={`${e.route}${e.status}`}>
            <td className="mo">{e.route}</td>
            <td className="mo">{e.status}</td>
            <td>{num(e.count)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Problem({ status }: { status: number }) {
  return (
    <div className="adm-alert" role="alert">
      {status === 403 ? 'บัญชีนี้ไม่มีสิทธิ์ดูภาพรวมระบบ (ต้องเป็นโอเปอเรเตอร์หรือแอดมิน)' : status === 429 ? RATE_LIMITED : 'โหลดภาพรวมไม่ได้ในขณะนี้ ลองใหม่อีกครั้ง'}
    </div>
  );
}

export function OverviewView({ overview: o, status, window }: { overview?: Overview; status: number; window: OverviewWindow }) {
  const { theme } = useAdmin();
  const [sel, setSel] = useState(0);
  if (!o) return <Problem status={status} />;
  const k = kpis(o);

  if (theme === 'control-room') {
    return (
      <div className="cr-page ov">
        <div className="top">
          <div className="crumb">
            Operations<b>ภาพรวมระบบ</b>
          </div>
          <WindowPicker window={window} className="seg" />
        </div>
        <div className="ov-kpis cr-kpis">
          {k.map((x) => (
            <div key={x.id} className={`pn${x.warn ? ' warn' : ''}`}>
              <small>{x.label}</small>
              <b className="mo">{x.value}</b>
              <span className="dim">{x.sub}</span>
            </div>
          ))}
        </div>
        <div className="ov-grid">
          <div className="pn">
            <h3>Traffic · {winLabel(o.window.id)}</h3>
            <TrafficChart o={o} />
          </div>
          <div className="pn">
            <h3>Incidents</h3>
            <Incidents o={o} className="ov-list" />
            <h3>Top 5xx routes</h3>
            <TopErrors o={o} />
          </div>
        </div>
        <Footnote o={o} />
      </div>
    );
  }

  if (theme === 'broadcast-rack') {
    const meter = (v: number, max: number) => Math.max(0, Math.min(1, max ? v / max : 0));
    return (
      <div className="br-page ov">
        <div className="ttl">
          <h3>ภาพรวมระบบ · On Air</h3>
          <span>ตัวเลขรวม {winLabel(o.window.id)}</span>
        </div>
        <div className="br-pick">
          <WindowPicker window={window} className="knobs" />
        </div>
        <div className="ov-lamps" aria-label="สัญญาณเตือน">
          {o.incidents.length === 0 ? (
            <span className="lamp-row">
              <i className="lamp ok" aria-hidden="true" /> ทุกช่องปกติ
            </span>
          ) : (
            o.incidents.map((i) => (
              <span key={i.code} className="lamp-row">
                <i className={`lamp ${i.severity}`} aria-hidden="true" />
                <span className="sr-only">{i.severity === 'critical' ? 'วิกฤต: ' : 'เตือน: '}</span>
                {INCIDENTS[i.code].title} · {detailOf(i)}
              </span>
            ))
          )}
        </div>
        <div className="ov-meters adm-panel">
          {[
            { label: 'อัตรา 5xx', value: pct(o.api.errorRate), fill: meter(o.api.errorRate ?? 0, 0.1), warn: k[1].warn, sub: k[1].sub },
            { label: 'เวลาตอบ p95', value: ms(o.api.p95Ms), fill: meter(o.api.p95Ms ?? 0, 2000), warn: (o.api.p95Ms ?? 0) > 1000, sub: k[2].sub },
            { label: 'สถานีน่าสงสัย', value: num(o.stations.health.suspect), fill: meter(o.stations.health.suspect, Math.max(1, o.stations.published)), warn: k[3].warn, sub: k[3].sub },
            { label: 'คิวลบบัญชี', value: num(o.queues.accountDeletions.open), fill: meter(o.queues.accountDeletions.open, 10), warn: k[4].warn, sub: k[4].sub },
          ].map((m) => (
            <div key={m.label} className="ov-meter">
              <span className="lbl">{m.label}</span>
              <span className="vu" role="meter" aria-label={m.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(m.fill * 100)} aria-valuetext={m.value}>
                <span className={m.warn ? 'warn' : undefined} style={{ width: `${m.fill * 100}%` }} />
              </span>
              <b className="mo">{m.value}</b>
              <small className="dim">{m.sub}</small>
            </div>
          ))}
        </div>
        <div className="adm-panel">
          <h4>คำขอ {num(o.api.requests)} ครั้ง</h4>
          <TrafficChart o={o} height={110} />
        </div>
        <Footnote o={o} />
      </div>
    );
  }

  if (theme === 'daylight-bento') {
    return (
      <div className="db-page ov">
        <div className="hello">
          <div>
            <h3>ภาพรวมระบบ</h3>
            <p>สรุป {winLabel(o.window.id)} ล่าสุด ตัวเลขรวมเท่านั้น</p>
          </div>
        </div>
        <div className="search">
          <WindowPicker window={window} className="chips" />
        </div>
        <div className="ov-bento">
          <section className="b-alert">
            <h4>เรื่องที่ต้องดู</h4>
            <Incidents o={o} className="ov-list" />
          </section>
          {k.map((x) => (
            <section key={x.id} className={`b-kpi${x.warn ? ' warn' : ''}`}>
              <small>{x.label}</small>
              <b>{x.value}</b>
              <span>{x.sub}</span>
            </section>
          ))}
          <section className="b-chart">
            <h4>คำขอ API</h4>
            <TrafficChart o={o} />
          </section>
          <section className="b-err">
            <h4>เส้นทางที่ตอบ 5xx บ่อยสุด</h4>
            <TopErrors o={o} />
          </section>
        </div>
        <Footnote o={o} />
      </div>
    );
  }

  if (theme === 'workbench') {
    const items = [
      ...o.incidents.map((i) => ({ id: i.code, title: INCIDENTS[i.code].title, sub: detailOf(i), sev: i.severity as string })),
      { id: 'traffic', title: 'คำขอ API', sub: `${num(o.api.requests)} คำขอ · 5xx ${pct(o.api.errorRate)}`, sev: 'info' },
      { id: 'stations', title: 'สุขภาพสถานี', sub: k[3].sub, sev: 'info' },
      { id: 'queues', title: 'คิวงานเบื้องหลัง', sub: k[4].sub, sev: 'info' },
    ];
    const cur = items[Math.min(sel, items.length - 1)];
    return (
      <div className="split">
        <section className="list" aria-label="รายการภาพรวม">
          <div className="lh">
            <h3>
              ภาพรวมระบบ <span>{o.incidents.length}</span>
            </h3>
            <WindowPicker window={window} className="wb-seg" />
          </div>
          <ul>
            {items.map((it, i) => (
              <li key={it.id} className={`it ov-it ${it.sev}${it === cur ? ' sel' : ''}`}>
                <i className={`ic ov-ic ${it.sev}`} aria-hidden="true" />
                <button type="button" className="lg-pick" onClick={() => setSel(i)} aria-pressed={it === cur}>
                  <b>{it.title}</b>
                </button>
                <small>{it.sub}</small>
              </li>
            ))}
          </ul>
        </section>
        <section className="det" aria-label="รายละเอียด">
          <div className="lg-detail">
            <p className="crumb">ภาพรวมระบบ / {winLabel(o.window.id)}</p>
            <h2>{cur.title}</h2>
            <p className="dim">{cur.sub}</p>
            {cur.id === 'stations' ? (
              <dl className="ov-dl">
                {(['ok', 'failing', 'suspect', 'unknown'] as const).map((s) => (
                  <div key={s}>
                    <dt>{{ ok: 'เล่นได้', failing: 'ตรวจไม่ผ่าน', suspect: 'น่าสงสัย', unknown: 'ยังไม่ได้ตรวจ' }[s]}</dt>
                    <dd className="mo">{o.stations.health[s]}</dd>
                  </div>
                ))}
              </dl>
            ) : cur.id === 'queues' ? (
              <dl className="ov-dl">
                <div>
                  <dt>คำขอลบบัญชีค้าง</dt>
                  <dd className="mo">{o.queues.accountDeletions.open}</dd>
                </div>
                <div>
                  <dt>ลบไม่สำเร็จ (กำลังลองใหม่)</dt>
                  <dd className="mo">{o.queues.accountDeletions.failed}</dd>
                </div>
                <div>
                  <dt>รายงานวินิจฉัยในช่วงนี้</dt>
                  <dd className="mo">{o.queues.diagnosticReports}</dd>
                </div>
              </dl>
            ) : (
              <>
                <TrafficChart o={o} />
                <TopErrors o={o} />
              </>
            )}
            <Footnote o={o} />
          </div>
        </section>
      </div>
    );
  }

  // Minimal (FinVault cards)
  return (
    <div className="fv-dash ov">
      <div className="fv-logstats ov-fv">
        {k.slice(0, 4).map((x) => (
          <section key={x.id} className="fv-card">
            <small className="fv-label">{x.label}</small>
            <p className={`fv-amount${x.warn ? ' hot' : ''}`}>{x.value}</p>
            <small>{x.sub}</small>
          </section>
        ))}
      </div>
      <section className="fv-card" aria-labelledby="fv-ov-traffic">
        <div className="fv-card-head">
          <div>
            <h2 id="fv-ov-traffic">คำขอ API</h2>
            <small>{winLabel(o.window.id)} ล่าสุด · ตัวเลขรวมเท่านั้น</small>
          </div>
          <WindowPicker window={window} className="fv-seg" />
        </div>
        <TrafficChart o={o} />
      </section>
      <section className="fv-card" aria-labelledby="fv-ov-inc">
        <div className="fv-card-head">
          <div>
            <h2 id="fv-ov-inc">เรื่องที่ต้องดู</h2>
            <small>{k[4].label} {k[4].value} · {k[4].sub}</small>
          </div>
          <span className="ov-count">
            <Icon name="bolt" /> {o.incidents.length} เรื่อง
          </span>
        </div>
        <Incidents o={o} className="fv-tx ov-list" />
      </section>
      <Footnote o={o} />
    </div>
  );
}
