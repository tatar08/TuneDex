'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  countByStatus,
  FILTER_LABELS,
  formatDate,
  formatDateTime,
  HEALTH_LABELS,
  healthLine,
  healthOf,
  isLive,
  initials,
  rightsLine,
  rightsSoon,
  STATUS_FILTERS,
  STATUS_LABELS,
  StatusFilter,
  subtitle,
} from '@/lib/admin';
import type { AdminStation } from '@/lib/bff';
import { useAdmin } from '../AdminShell';
import { MinimalDashboard } from './MinimalDashboard';

const href = (s: AdminStation) => `/admin/stations/${s.id}`;
const filterHref = (f: StatusFilter) => (f === 'all' ? '/admin/stations' : `/admin/stations?status=${f}`);
const actionLabel = (s: AdminStation) => (s.status === 'changes_pending' || s.status === 'draft' ? 'ตรวจ' : 'แก้ไข');

/** Stable, decorative card color from the station id (Daylight Bento). */
function artColor(id: string): string {
  const palette = ['#2f6bd8', '#b8862a', '#c2504a', '#5b4bc4', '#2a9d8f', '#7a8f2a', '#3c8d4f', '#3949ab'];
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return palette[h % palette.length];
}

function Filters({ filter, counts, className }: { filter: StatusFilter; counts: Record<StatusFilter, number>; className: string }) {
  return (
    <nav className={className} aria-label="กรองตามสถานะ">
      {STATUS_FILTERS.map((f) => (
        <Link key={f} href={filterHref(f)} className={f === filter ? 'on' : undefined} aria-current={f === filter ? 'true' : undefined}>
          {FILTER_LABELS[f]} {counts[f]}
        </Link>
      ))}
    </nav>
  );
}

function Empty({ filter }: { filter: StatusFilter }) {
  return <p className="adm-empty">{filter === 'all' ? 'ยังไม่มีสถานี' : `ไม่มีสถานีที่${FILTER_LABELS[filter]}`}</p>;
}

/** Stream health for live stations; drafts and disabled stations show a dash. */
function Health({ s, className = 'hl-line' }: { s: AdminStation; className?: string }) {
  if (!isLive(s)) return <span className={`${className} dim`}>—</span>;
  const h = healthOf(s);
  return (
    <span className={`${className} ${h.state}`} title={healthLine(h)}>
      <i className={`hl-dot ${h.state}`} aria-hidden="true" />
      {HEALTH_LABELS[h.state]}
    </span>
  );
}

function NewButton({ className }: { className: string }) {
  const { canEdit } = useAdmin();
  return canEdit ? (
    <Link href="/admin/stations/new" className={className}>
      + เพิ่มสถานี
    </Link>
  ) : null;
}

/** Workbench: list pane with keyboard navigation (j/k to move, Enter to open) beside a detail pane. */
export function WorkbenchSplit({
  stations,
  filter,
  selectedId,
  children,
}: {
  stations: AdminStation[];
  filter: StatusFilter;
  selectedId?: string;
  children?: React.ReactNode;
}) {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const counts = useMemo(() => countByStatus(stations), [stations]);
  const shown = stations
    .filter((s) => filter === 'all' || s.status === filter)
    .filter((s) => !query || s.draft.name.toLowerCase().includes(query.toLowerCase()));
  const [cursor, setCursor] = useState(() => Math.max(0, shown.findIndex((s) => s.id === selectedId)));
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement;
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'j') setCursor((c) => Math.min(c + 1, shown.length - 1));
      else if (e.key === 'k') setCursor((c) => Math.max(c - 1, 0));
      else if (e.key === 'Enter' && shown[cursor] && target === document.body) router.push(href(shown[cursor]));
      else return;
      e.preventDefault();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [shown, cursor, router]);

  useEffect(() => {
    listRef.current?.querySelectorAll('li')[cursor]?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  return (
    <div className="split">
      <section className="list" aria-label="รายการสถานี">
        <div className="lh">
          <h3>
            สถานีวิทยุ <span>{shown.length}</span>
          </h3>
          <input className="cmd" placeholder="ค้นหาชื่อสถานี" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="ค้นหาชื่อสถานี" />
          <Filters filter={filter} counts={counts} className="tabs" />
          <NewButton className="btn" />
        </div>
        {shown.length === 0 ? (
          <Empty filter={filter} />
        ) : (
          <ul ref={listRef}>
            {shown.map((s, i) => (
              <li key={s.id} className={`it${s.id === selectedId ? ' sel' : ''}${i === cursor ? ' cur' : ''}`}>
                <i className={`ic ${s.status}`} aria-hidden="true" />
                <Link href={href(s)} aria-current={s.id === selectedId ? 'page' : undefined}>
                  <b>{s.draft.name}</b>
                </Link>
                <span className="r">r{s.revision}</span>
                <small>
                  {STATUS_LABELS[s.status]} · {subtitle(s)} · <span className={rightsSoon(s) ? 'wr' : undefined}>{rightsLine(s)}</span>
                  {isLive(s) && (
                    <>
                      {' · '}
                      <Health s={s} />
                    </>
                  )}
                </small>
              </li>
            ))}
          </ul>
        )}
        <p className="foot">
          <kbd>j</kbd> <kbd>k</kbd> เลื่อน · <kbd>Enter</kbd> เปิด
        </p>
      </section>
      <section className="det">{children ?? <p className="adm-empty">เลือกสถานีจากรายการทางซ้าย</p>}</section>
    </div>
  );
}

export function StationsView({ stations, filter, query: initialQuery = '' }: { stations: AdminStation[]; filter: StatusFilter; query?: string }) {
  const { theme } = useAdmin();
  const [query, setQuery] = useState('');
  const counts = useMemo(() => countByStatus(stations), [stations]);
  const shown = stations.filter((s) => filter === 'all' || s.status === filter);
  const summary = `${counts.all} สถานี · เผยแพร่ ${counts.published} · รอตรวจ ${counts.changes_pending} · ร่าง ${counts.draft}`;

  if (theme === 'workbench') return <WorkbenchSplit stations={stations} filter={filter} />;

  if (theme === 'control-room') {
    return (
      <div className="cr-page">
        <div className="top">
          <div className="crumb">
            Catalog<b>สถานีวิทยุ</b>
          </div>
          <Filters filter={filter} counts={counts} className="seg" />
          <NewButton className="btn" />
        </div>
        <div className="pn">
          {shown.length === 0 ? (
            <Empty filter={filter} />
          ) : (
            <table>
              <thead>
                <tr>
                  <th scope="col">สถานี</th>
                  <th scope="col">ภาษา / แนว</th>
                  <th scope="col">สถานะ</th>
                  <th scope="col">สิทธิ์</th>
                  <th scope="col">สตรีม</th>
                  <th scope="col">Rev</th>
                  <th scope="col">แก้ไขล่าสุด</th>
                  <th scope="col">
                    <span className="sr-only">การทำงาน</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {shown.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <Link href={href(s)} className="nm">
                        {s.draft.name}
                      </Link>{' '}
                      <span className="mo dim">{s.draft.country}</span>
                    </td>
                    <td>{subtitle(s)}</td>
                    <td>
                      <span className={`tag ${s.status}`}>{STATUS_LABELS[s.status]}</span>
                    </td>
                    <td className={rightsSoon(s) ? 'wr' : undefined}>{rightsLine(s)}</td>
                    <td>{isLive(s) ? <span className={`tag hl-${healthOf(s).state}`} title={healthLine(healthOf(s))}>{HEALTH_LABELS[healthOf(s).state]}</span> : <span className="dim">—</span>}</td>
                    <td className="mo">r{s.revision}</td>
                    <td className="mo">{formatDateTime(s.updatedAt)}</td>
                    <td>
                      <Link href={href(s)} aria-label={`${actionLabel(s)} ${s.draft.name}`}>
                        {actionLabel(s)} →
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <p className="note">{summary}</p>
      </div>
    );
  }

  if (theme === 'broadcast-rack') {
    return (
      <div className="br-page">
        <div className="ttl">
          <h3>สถานีวิทยุ · Presets</h3>
          <span>{summary}</span>
          <NewButton className="btn" />
        </div>
        <Filters filter={filter} counts={counts} className="knobs" />
        {shown.length === 0 ? (
          <Empty filter={filter} />
        ) : (
          <div className="presets">
            {shown.map((s, i) => (
              <Link key={s.id} href={href(s)} className="pre">
                <span className="ch">
                  <span>CH {String(i + 1).padStart(2, '0')}</span>
                  <span>r{s.revision}</span>
                </span>
                <b>{s.draft.name}</b>
                <small>{subtitle(s)}</small>
                <span className="st">
                  <i className={`lamp ${s.status}`} aria-hidden="true" />
                  {STATUS_LABELS[s.status]}
                </span>
                <small className={rightsSoon(s) ? 'wr' : undefined}>{rightsLine(s)}</small>
                <span className="sig">
                  SIG <Health s={s} className="hl-sig" />
                </span>
              </Link>
            ))}
          </div>
        )}
      </div>
    );
  }

  if (theme === 'daylight-bento') {
    const found = shown.filter((s) => !query || s.draft.name.toLowerCase().includes(query.toLowerCase()));
    return (
      <div className="db-page">
        <div className="hello">
          <div>
            <h3>สถานีวิทยุ</h3>
            <p>{summary}</p>
          </div>
          <NewButton className="btn" />
        </div>
        <div className="search">
          <input className="in" placeholder="ค้นหาชื่อสถานี" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="ค้นหาชื่อสถานี" />
          <Filters filter={filter} counts={counts} className="chips" />
        </div>
        {found.length === 0 ? (
          <Empty filter={filter} />
        ) : (
          <div className="stgrid">
            {found.map((s) => (
              <Link key={s.id} href={href(s)} className="st">
                <span className="art" style={{ background: `linear-gradient(135deg, ${artColor(s.id)}, ${artColor(s.id + 'x')})` }} aria-hidden="true">
                  {initials(s.draft.name)}
                </span>
                <b>{s.draft.name}</b>
                <small>{subtitle(s)}</small>
                <span className="ft">
                  <span className={`pill ${s.status}`}>{STATUS_LABELS[s.status]}</span>
                  <span className={rightsSoon(s) ? 'wr' : undefined}>{rightsLine(s)}</span>
                </span>
                {isLive(s) && <Health s={s} className="hl-chip" />}
              </Link>
            ))}
          </div>
        )}
      </div>
    );
  }

  return <MinimalDashboard stations={stations} filter={filter} query={initialQuery} />;
}
