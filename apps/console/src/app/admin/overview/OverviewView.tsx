'use client';

import { useState } from 'react';
import { formatLogTime, RATE_LIMITED } from '@/lib/admin';
import type { IncidentCode, Overview, OverviewWindow } from '@/lib/bff';
import type { Translate } from '@/lib/admin-i18n';
import type { Lang } from '@/lib/i18n';
import { Icon, useAdmin, useT } from '../AdminShell';

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

const INCIDENTS: Record<IncidentCode, { title: string; detail: string; href?: string }> = {
  api_error_rate: { title: 'API ตอบ error บ่อย', detail: '{0} คำขอจบด้วย 5xx เกิน 5% ของทั้งหมด', href: '/admin/logs?severity=ERROR' },
  account_deletion_failed: { title: 'ลบบัญชีไม่สำเร็จ', detail: '{0} คำขอลบไม่สำเร็จ (กำลังลองใหม่หรือรอทีมงาน) ดูบันทึก ACCOUNT_PURGE_FAILED', href: '/admin/jobs?status=failed' },
  account_deletion_late: { title: 'ลบบัญชีใกล้เกินกำหนด 30 วัน', detail: '{0} คำขอค้างนานกว่า 25 วัน' },
  account_deletion_stuck: { title: 'คิวลบบัญชีค้าง', detail: '{0} คำขอถึงรอบแล้วแต่ยังไม่ได้ทำเกิน 5 นาที', href: '/admin/jobs' },
  account_export_stuck: { title: 'คิวส่งออกข้อมูลค้าง', detail: '{0} คำขอถึงรอบแล้วแต่ยังไม่ได้ทำเกิน 5 นาที', href: '/admin/jobs' },
  idp_session_end_stuck: { title: 'คิวปิดเซสชัน Keycloak ค้าง', detail: '{0} รายการถึงรอบแล้วแต่ยังไม่ได้ทำเกิน 5 นาที', href: '/admin/jobs' },
  job_dead_letter: { title: 'งานเบื้องหลังรอทีมงาน', detail: '{0} งานลองครบ 5 ครั้งแล้วไม่สำเร็จ ต้องสั่งลองใหม่', href: '/admin/jobs?status=dead_letter' },
  api_latency: { title: 'API ตอบช้า', detail: 'p95 {0} ms เกิน 1 วินาที ใน 10 นาทีล่าสุด', href: '/admin/logs' },
  stations_suspect: { title: 'สถานีน่าสงสัย', detail: '{0} สถานีตรวจไม่ผ่าน 3 ครั้งติด รอแอดมินตรวจ', href: '/admin/stations' },
  station_checker_stale: { title: 'ตัวตรวจสตรีมไม่ได้รัน', detail: 'ไม่มีผลตรวจใหม่นานเกิน 2.5 รอบ' },
  backup_stale: { title: 'ไม่มี backup ใหม่', detail: 'backup ล่าสุดเมื่อ {0} ชั่วโมงก่อน เกิน 24 ชั่วโมง ตรวจงาน backup.sh' },
  station_rights_expiring: { title: 'สิทธิ์เผยแพร่ใกล้หมด', detail: '{0} สถานีสิทธิ์จะหมดใน 14 วัน ต้องเพิ่มหลักฐานใหม่ ไม่อย่างนั้นจะหายจากแอป', href: '/admin/stations' },
  no_recent_traffic: { title: 'ไม่มีคำขอเข้ามาเลย', detail: 'ไม่มีคำขอใน 15 นาทีล่าสุด ตัวเลขอาจไม่ใช่สถานะตอนนี้' },
};

/** An open alert also says since when (Doc 17 rules, checked every minute). */
const detailOf = (t: Translate, i: Overview['incidents'][number]) =>
  t(INCIDENTS[i.code].detail, i.code === 'api_latency' ? num(i.count) : i.count) + (i.since ? ' · ' + t('ตั้งแต่ {0}', formatLogTime(i.since, t.lang)) : '');

const pct = (r: number | null) => (r === null ? '—' : `${(r * 100).toFixed(r < 0.1 ? 1 : 0)}%`);
const ms = (v: number | null) => (v === null ? '—' : v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${v} ms`);
const num = (v: number) => v.toLocaleString('th-TH');
const winLabel = (t: Translate, w: OverviewWindow) => t(WINDOWS.find((x) => x.id === w)!.label);
const tick = (iso: string, w: OverviewWindow, lang: Lang) =>
  new Intl.DateTimeFormat(lang === 'en' ? 'en-GB' : 'th-TH', { timeZone: 'Asia/Bangkok', ...(w === '7d' ? { day: 'numeric', month: 'short' } : { hour: '2-digit', minute: '2-digit' }) }).format(new Date(iso));

function WindowPicker({ window, className }: { window: OverviewWindow; className: string }) {
  const t = useT();
  return (
    <nav className={className} aria-label={t('ช่วงเวลา')}>
      {WINDOWS.map((w) => (
        <a key={w.id} href={w.id === '24h' ? '/admin/overview' : `/admin/overview?window=${w.id}`} className={w.id === window ? 'on' : undefined} aria-current={w.id === window ? 'true' : undefined}>
          {t(w.label)}
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
  const { lang, t } = useAdmin();
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
          <i className="ok" /> {t('สำเร็จและ 4xx')}
        </span>
        <span>
          <i className="err" /> 5xx
        </span>
        <span className="dim">{t('สูงสุด {0} คำขอต่อช่อง', num(max))}</span>
      </div>
      <div className="ov-plot">
        <svg viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none" role="img" aria-label={t('คำขอ API ใน {0} ล่าสุด แยกช่องละช่วงเวลา', winLabel(t, o.window.id))}>
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
            <b>{tick(h.at, o.window.id, lang)}</b>
            <span>{t('{0} คำขอ', num(h.requests))}</span>
            <span>5xx {num(h.serverErrors)}</span>
            <span>p95 {ms(h.p95Ms)}</span>
          </div>
        )}
      </div>
      <div className="ov-axis dim" aria-hidden="true">
        <span>{tick(o.window.from, o.window.id, lang)}</span>
        <span>{t('ตอนนี้')}</span>
      </div>
      <table className="sr-only">
        <caption>{t('คำขอ API ต่อช่วงเวลา')}</caption>
        <thead>
          <tr>
            <th scope="col">{t('เริ่ม')}</th>
            <th scope="col">{t('คำขอ')}</th>
            <th scope="col">5xx</th>
            <th scope="col">p95</th>
          </tr>
        </thead>
        <tbody>
          {b.map((x) => (
            <tr key={x.at}>
              <td>{tick(x.at, o.window.id, lang)}</td>
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
  const t = useT();
  if (o.incidents.length === 0) {
    return (
      <p className="ov-calm">
        <span className="ov-sev ok" aria-hidden="true">✓</span> {t('ไม่มีเรื่องที่ต้องดูตอนนี้')}
      </p>
    );
  }
  return (
    <ul className={className} aria-label={t('เรื่องที่ต้องดู')}>
      {o.incidents.map((i) => {
        const d = INCIDENTS[i.code];
        return (
          <li key={i.code} className={i.severity}>
            <span className={`ov-sev ${i.severity}`} aria-hidden="true">
              {i.severity === 'critical' ? '!' : '•'}
            </span>
            <span className="ov-inc">
              <b>
                <span className="sr-only">{i.severity === 'critical' ? t('วิกฤต: ') : t('เตือน: ')}</span>
                {t(d.title)}
              </b>
              <small>{detailOf(t, i)}</small>
            </span>
            {d.href && (
              <a href={d.href} className="adm-link">
                {t('ดู')}
              </a>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** The headline figures, each with the sample it comes from. */
function kpis(t: Translate, o: Overview) {
  const h = o.stations.health;
  return [
    { id: 'req', label: t('คำขอ API'), value: num(o.api.requests), sub: o.api.stale ? t('ไม่มีคำขอใน 15 นาทีล่าสุด') : t('ล่าสุด {0}', o.api.lastRequestAt ? formatLogTime(o.api.lastRequestAt, t.lang) : '—'), warn: o.api.stale },
    {
      id: 'err',
      label: t('อัตรา 5xx'),
      value: pct(o.api.errorRate),
      sub: o.api.requests < 50 ? t('จาก {0} คำขอ ยังน้อยเกินจะสรุป', num(o.api.requests)) : t('{0} จาก {1} คำขอ', num(o.api.serverErrors), num(o.api.requests)),
      warn: o.incidents.some((i) => i.code === 'api_error_rate'),
    },
    { id: 'lat', label: t('เวลาตอบ p95'), value: ms(o.api.p95Ms), sub: t('ค่ากลาง {0}', ms(o.api.p50Ms)), warn: false },
    {
      id: 'st',
      label: t('สถานีที่เปิดอยู่'),
      value: num(o.stations.published),
      sub: t('เล่นได้ {0} · ไม่ผ่าน {1} · น่าสงสัย {2} · ยังไม่ตรวจ {3}', h.ok, h.failing, h.suspect, h.unknown),
      warn: h.suspect > 0,
    },
    {
      id: 'del',
      label: t('คิวลบบัญชี'),
      value: num(o.queues.accountDeletions.open),
      sub: o.queues.accountDeletions.failed
        ? t('ไม่สำเร็จ {0} · ต้องเสร็จใน {1} วัน', o.queues.accountDeletions.failed, o.queues.accountDeletions.deadlineDays)
        : t('ต้องเสร็จใน {0} วัน', o.queues.accountDeletions.deadlineDays),
      warn: o.queues.accountDeletions.failed > 0,
    },
  ];
}

function Footnote({ o }: { o: Overview }) {
  const t = useT();
  const checker = o.stations.checkerEnabled
    ? t('ตัวตรวจสตรีม เปิดอยู่ ผลล่าสุด {0}', o.stations.lastCheckAt ? formatLogTime(o.stations.lastCheckAt, t.lang) : t('ยังไม่มี'))
    : t('ตัวตรวจสตรีม ปิดอยู่ (STATION_CHECK_ENABLED)');
  return (
    <p className="ov-foot dim">
      {t('ข้อมูล {0} ถึง {1}', winLabel(t, o.window.id), formatLogTime(o.generatedAt, t.lang))} · {checker} ·{' '}
      {t('รายงานวินิจฉัย {0} ฉบับ', num(o.queues.diagnosticReports))} · {t('ตัวเลขรวมเท่านั้น ไม่มีข้อมูลรายคน')}
    </p>
  );
}

function TopErrors({ o }: { o: Overview }) {
  const t = useT();
  if (o.api.topErrors.length === 0) return <p className="dim">{t('ไม่มี 5xx ในช่วงนี้')}</p>;
  return (
    <table className="ov-errors">
      <caption className="sr-only">{t('เส้นทางที่ตอบ 5xx บ่อยสุด')}</caption>
      <thead>
        <tr>
          <th scope="col">{t('เส้นทาง')}</th>
          <th scope="col">{t('สถานะ')}</th>
          <th scope="col">{t('ครั้ง')}</th>
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

/** Doc 07 event names, as staff read them. */
const EVENT_LABELS: Record<string, string> = {
  import_completed: 'นำเข้าสำเร็จ',
  import_failed: 'นำเข้าไม่สำเร็จ',
  playback_start_result: 'เริ่มเล่น',
  playback_stall: 'เสียงสะดุด',
  playback_recovered: 'เล่นต่อได้',
  app_error: 'แอปผิดพลาด',
  purchase_result: 'ซื้อ Pro',
  carplay_session_result: 'CarPlay / Android Auto',
};

/** Opt-in app diagnostics: attempts and failures per event, the most common failure classes, the busiest builds. */
function ClientDiagnostics({ o }: { o: Overview }) {
  const t = useT();
  const c = o.clients;
  if (c.events === 0) return <p className="dim">{t('ยังไม่มีรายงานจากแอปในช่วงนี้ (แอปส่งเฉพาะเมื่อผู้ใช้ยินยอม)')}</p>;
  const label = (name: string) => (EVENT_LABELS[name] ? t(EVENT_LABELS[name]) : name);
  return (
    <div className="ov-clients">
      <p className="dim">{t('{0} รายงานจาก {1} เครื่อง · {2} เหตุการณ์', num(c.reports), num(c.devices), num(c.events))}</p>
      <table className="ov-errors">
        <caption className="sr-only">{t('เหตุการณ์จากแอปและสัดส่วนที่ล้มเหลว')}</caption>
        <thead>
          <tr>
            <th scope="col">{t('เหตุการณ์')}</th>
            <th scope="col">{t('ครั้ง')}</th>
            <th scope="col">{t('ล้มเหลว')}</th>
            <th scope="col">{t('เครื่อง')}</th>
          </tr>
        </thead>
        <tbody>
          {c.byEvent.map((e) => (
            <tr key={e.eventName}>
              <td>{label(e.eventName)}</td>
              <td>{num(e.events)}</td>
              <td>
                {num(e.failures)} <span className="dim">({pct(e.events ? e.failures / e.events : null)})</span>
              </td>
              <td>{num(e.devices)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {c.topFailures.length > 0 && (
        <table className="ov-errors">
          <caption className="sr-only">{t('รหัสปัญหาที่พบบ่อยสุด')}</caption>
          <thead>
            <tr>
              <th scope="col">{t('รหัสปัญหา')}</th>
              <th scope="col">{t('เหตุการณ์')}</th>
              <th scope="col">{t('ครั้ง')}</th>
              <th scope="col">{t('เครื่อง')}</th>
            </tr>
          </thead>
          <tbody>
            {c.topFailures.map((f) => (
              <tr key={`${f.eventName}${f.resultCode}`}>
                <td className="mo">{f.resultCode}</td>
                <td>{label(f.eventName)}</td>
                <td>{num(f.count)}</td>
                <td>{num(f.devices)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="dim">
        {t('รุ่นที่ส่งมากสุด')}:{' '}
        {c.builds.map((b, i) => (
          <span key={`${b.appBuild}${b.platform}`}>
            {i > 0 && ' · '}
            <span className="mo">{b.appBuild}</span> {b.platform === 'ios' ? 'iOS' : 'Android'} {t('ล้มเหลว {0}/{1}', num(b.failures), num(b.events))}
          </span>
        ))}
      </p>
    </div>
  );
}

function Problem({ status }: { status: number }) {
  const t = useT();
  return (
    <div className="adm-alert" role="alert">
      {status === 403 ? t('บัญชีนี้ไม่มีสิทธิ์ดูภาพรวมระบบ (ต้องเป็นโอเปอเรเตอร์หรือแอดมิน)') : status === 429 ? t(RATE_LIMITED) : t('โหลดภาพรวมไม่ได้ในขณะนี้ ลองใหม่อีกครั้ง')}
    </div>
  );
}

export function OverviewView({ overview: o, status, window }: { overview?: Overview; status: number; window: OverviewWindow }) {
  const { theme, t } = useAdmin();
  const [sel, setSel] = useState(0);
  if (!o) return <Problem status={status} />;
  const k = kpis(t, o);

  if (theme === 'control-room') {
    return (
      <div className="cr-page ov">
        <div className="top">
          <div className="crumb">
            Operations<b>{t('ภาพรวมระบบ')}</b>
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
            <h3>Traffic · {winLabel(t, o.window.id)}</h3>
            <TrafficChart o={o} />
          </div>
          <div className="pn">
            <h3>Incidents</h3>
            <Incidents o={o} className="ov-list" />
            <h3>Top 5xx routes</h3>
            <TopErrors o={o} />
          </div>
          <div className="pn">
            <h3>App diagnostics</h3>
            <ClientDiagnostics o={o} />
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
          <h3>{t('ภาพรวมระบบ')} · On Air</h3>
          <span>{t('ตัวเลขรวม {0}', winLabel(t, o.window.id))}</span>
        </div>
        <div className="br-pick">
          <WindowPicker window={window} className="knobs" />
        </div>
        <div className="ov-lamps" aria-label={t('สัญญาณเตือน')}>
          {o.incidents.length === 0 ? (
            <span className="lamp-row">
              <i className="lamp ok" aria-hidden="true" /> {t('ทุกช่องปกติ')}
            </span>
          ) : (
            o.incidents.map((i) => (
              <span key={i.code} className="lamp-row">
                <i className={`lamp ${i.severity}`} aria-hidden="true" />
                <span className="sr-only">{i.severity === 'critical' ? t('วิกฤต: ') : t('เตือน: ')}</span>
                {t(INCIDENTS[i.code].title)} · {detailOf(t, i)}
              </span>
            ))
          )}
        </div>
        <div className="ov-meters adm-panel">
          {[
            { label: t('อัตรา 5xx'), value: pct(o.api.errorRate), fill: meter(o.api.errorRate ?? 0, 0.1), warn: k[1].warn, sub: k[1].sub },
            { label: t('เวลาตอบ p95'), value: ms(o.api.p95Ms), fill: meter(o.api.p95Ms ?? 0, 2000), warn: (o.api.p95Ms ?? 0) > 1000, sub: k[2].sub },
            { label: t('สถานีน่าสงสัย'), value: num(o.stations.health.suspect), fill: meter(o.stations.health.suspect, Math.max(1, o.stations.published)), warn: k[3].warn, sub: k[3].sub },
            { label: t('คิวลบบัญชี'), value: num(o.queues.accountDeletions.open), fill: meter(o.queues.accountDeletions.open, 10), warn: k[4].warn, sub: k[4].sub },
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
          <h4>{t('คำขอ {0} ครั้ง', num(o.api.requests))}</h4>
          <TrafficChart o={o} height={110} />
        </div>
        <div className="adm-panel">
          <h4>{t('รายงานจากแอป')}</h4>
          <ClientDiagnostics o={o} />
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
            <h3>{t('ภาพรวมระบบ')}</h3>
            <p>{t('สรุป {0} ล่าสุด ตัวเลขรวมเท่านั้น', winLabel(t, o.window.id))}</p>
          </div>
        </div>
        <div className="search">
          <WindowPicker window={window} className="chips" />
        </div>
        <div className="ov-bento">
          <section className="b-alert">
            <h4>{t('เรื่องที่ต้องดู')}</h4>
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
            <h4>{t('คำขอ API')}</h4>
            <TrafficChart o={o} />
          </section>
          <section className="b-err">
            <h4>{t('เส้นทางที่ตอบ 5xx บ่อยสุด')}</h4>
            <TopErrors o={o} />
          </section>
          <section className="b-err">
            <h4>{t('รายงานจากแอป')}</h4>
            <ClientDiagnostics o={o} />
          </section>
        </div>
        <Footnote o={o} />
      </div>
    );
  }

  if (theme === 'workbench') {
    const items = [
      ...o.incidents.map((i) => ({ id: i.code, title: t(INCIDENTS[i.code].title), sub: detailOf(t, i), sev: i.severity as string })),
      { id: 'traffic', title: t('คำขอ API'), sub: t('{0} คำขอ · 5xx {1}', num(o.api.requests), pct(o.api.errorRate)), sev: 'info' },
      { id: 'stations', title: t('สุขภาพสถานี'), sub: k[3].sub, sev: 'info' },
      { id: 'queues', title: t('คิวงานเบื้องหลัง'), sub: k[4].sub, sev: 'info' },
      { id: 'clients', title: t('รายงานจากแอป'), sub: t('{0} เหตุการณ์ · ล้มเหลว {1}', num(o.clients.events), num(o.clients.byEvent.reduce((n, e) => n + e.failures, 0))), sev: 'info' },
    ];
    const cur = items[Math.min(sel, items.length - 1)];
    return (
      <div className="split">
        <section className="list" aria-label={t('รายการภาพรวม')}>
          <div className="lh">
            <h3>
              {t('ภาพรวมระบบ')} <span>{o.incidents.length}</span>
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
        <section className="det" aria-label={t('รายละเอียด')}>
          <div className="lg-detail">
            <p className="crumb">{t('ภาพรวมระบบ')} / {winLabel(t, o.window.id)}</p>
            <h2>{cur.title}</h2>
            <p className="dim">{cur.sub}</p>
            {cur.id === 'stations' ? (
              <dl className="ov-dl">
                {(['ok', 'failing', 'suspect', 'unknown'] as const).map((s) => (
                  <div key={s}>
                    <dt>{t({ ok: 'เล่นได้', failing: 'ตรวจไม่ผ่าน', suspect: 'น่าสงสัย', unknown: 'ยังไม่ได้ตรวจ' }[s])}</dt>
                    <dd className="mo">{o.stations.health[s]}</dd>
                  </div>
                ))}
              </dl>
            ) : cur.id === 'queues' ? (
              <dl className="ov-dl">
                <div>
                  <dt>{t('คำขอลบบัญชีค้าง')}</dt>
                  <dd className="mo">{o.queues.accountDeletions.open}</dd>
                </div>
                <div>
                  <dt>{t('ลบไม่สำเร็จ (ลองใหม่หรือรอทีมงาน)')}</dt>
                  <dd className="mo">{o.queues.accountDeletions.failed}</dd>
                </div>
                <div>
                  <dt>{t('รายงานวินิจฉัยในช่วงนี้')}</dt>
                  <dd className="mo">{o.queues.diagnosticReports}</dd>
                </div>
              </dl>
            ) : cur.id === 'clients' ? (
              <ClientDiagnostics o={o} />
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
            <h2 id="fv-ov-traffic">{t('คำขอ API')}</h2>
            <small>{t('{0} ล่าสุด · ตัวเลขรวมเท่านั้น', winLabel(t, o.window.id))}</small>
          </div>
          <WindowPicker window={window} className="fv-seg" />
        </div>
        <TrafficChart o={o} />
      </section>
      <section className="fv-card" aria-labelledby="fv-ov-inc">
        <div className="fv-card-head">
          <div>
            <h2 id="fv-ov-inc">{t('เรื่องที่ต้องดู')}</h2>
            <small>{k[4].label} {k[4].value} · {k[4].sub}</small>
          </div>
          <span className="ov-count">
            <Icon name="bolt" /> {t('{0} เรื่อง', o.incidents.length)}
          </span>
        </div>
        <Incidents o={o} className="fv-tx ov-list" />
      </section>
      <section className="fv-card" aria-labelledby="fv-ov-clients">
        <div className="fv-card-head">
          <div>
            <h2 id="fv-ov-clients">{t('รายงานจากแอป')}</h2>
            <small>{t('{0} ล่าสุด · เฉพาะผู้ที่ยินยอมส่ง', winLabel(t, o.window.id))}</small>
          </div>
        </div>
        <ClientDiagnostics o={o} />
      </section>
      <Footnote o={o} />
    </div>
  );
}
