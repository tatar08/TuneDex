'use client';

import { useEffect, useRef, useState } from 'react';
import {
  actionFamily,
  actionLabel,
  RATE_LIMITED,
  actorKey,
  actorName,
  AUDIT_FAMILIES,
  AUDIT_FIELD_LABELS,
  AUDIT_RANGES,
  auditHref,
  AuditSearch,
  canSeeStations,
  changeSummary,
  formatDay,
  formatLogTime,
} from '@/lib/admin';
import type { AuditEvent, AuditPage } from '@/lib/bff';
import { Icon, useAdmin } from '../AdminShell';

/**
 * Staff audit trail (Doc 17 /admin/audit): who, what, when, why and a change summary.
 * Data and filters are shared; each theme lays the page out its own way (Tar, 2026-10-03). Read-only.
 */
export interface AuditViewProps {
  page?: AuditPage;
  status: number;
  badField?: string;
  search: AuditSearch;
  older: string | null;
}

const NOTE = 'บันทึกนี้แก้ไขหรือลบไม่ได้ และการเปิดดูแต่ละครั้งก็ถูกบันทึกไว้';
const shortId = (v: string) => (v.length > 14 ? `${v.slice(0, 6)}…${v.slice(-6)}` : v);
const fam = (e: AuditEvent) => actionFamily(e.action);

function Target({ e }: { e: AuditEvent }) {
  const { roles } = useAdmin();
  const label = e.targetType === 'station' ? 'สถานี' : e.targetType === 'user' ? 'บัญชี' : e.targetType;
  if (e.targetType === 'station' && canSeeStations(roles)) {
    return (
      <a href={`/admin/stations/${e.targetId}`} title={e.targetId}>
        {label} {e.targetLabel ?? shortId(e.targetId)}
      </a>
    );
  }
  return (
    <span title={e.targetId}>
      {label} {e.targetId === '*' ? '' : (e.targetLabel ?? shortId(e.targetId))}
    </span>
  );
}

function ActorLink({ e, search }: { e: AuditEvent; search: AuditSearch }) {
  return (
    <a href={auditHref({ ...search, actor: actorKey(e), cursor: '', to: '' })} title={`ดูทุกอย่างที่ ${actorName(e)} ทำ`}>
      {actorName(e)}
    </a>
  );
}

function Problem({ status, badField }: { status: number; badField?: string }) {
  return (
    <div className="adm-alert" role="alert">
      {status === 403
        ? 'บัญชีนี้ไม่มีสิทธิ์ดูประวัติการแก้ไข (ต้องเป็นผู้ตรวจสอบหรือแอดมิน)'
        : status === 400
          ? `ค่าที่กรอกไม่ถูกต้อง: ${badField ? (AUDIT_FIELD_LABELS[badField] ?? badField) : 'ตัวกรอง'}`
          : status === 429
            ? RATE_LIMITED
            : 'โหลดประวัติไม่ได้ในขณะนี้ ลองใหม่อีกครั้ง'}
    </div>
  );
}

const Empty = () => <p className="adm-empty">ไม่พบรายการตามเงื่อนไขนี้ในช่วงเวลาที่เลือก</p>;

function SearchForm({ search, className, pickers = true }: { search: AuditSearch; className: string; pickers?: boolean }) {
  return (
    <form className={className} method="get" action="/admin/audit" aria-label="ค้นหาประวัติ">
      {pickers ? (
        <>
          <label className="fld">
            <span>ช่วงเวลา</span>
            <select name="range" defaultValue={search.range}>
              {AUDIT_RANGES.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>
          <label className="fld">
            <span>การกระทำ</span>
            <select name="family" defaultValue={search.family}>
              {AUDIT_FAMILIES.map((f) => (
                <option key={f.id || 'all'} value={f.id}>
                  {f.label}
                </option>
              ))}
            </select>
          </label>
        </>
      ) : (
        <>
          <input type="hidden" name="range" value={search.range} />
          <input type="hidden" name="family" value={search.family} />
        </>
      )}
      <label className="fld">
        <span>ผู้กระทำ</span>
        <input name="actor" defaultValue={search.actor} maxLength={128} placeholder="subject หรือ operator:ชื่อ" />
      </label>
      <label className="fld">
        <span>เป้าหมาย (id)</span>
        <input name="targetId" defaultValue={search.targetId} maxLength={64} />
      </label>
      <label className="fld">
        <span>requestId</span>
        <input name="requestId" defaultValue={search.requestId} maxLength={64} />
      </label>
      <label className="chk-inline">
        <input type="checkbox" name="reads" value="1" defaultChecked={search.reads === '1'} />
        <span>รวมการเปิดดู</span>
      </label>
      <div className="lg-actions">
        <button type="submit" className="btn">
          ค้นหา
        </button>
        <a href="/admin/audit" className="adm-link">
          ล้างตัวกรอง
        </a>
      </div>
    </form>
  );
}

function Pickers({ search, className }: { search: AuditSearch; className: string }) {
  return (
    <>
      <nav className={className} aria-label="ช่วงเวลา">
        {AUDIT_RANGES.map((r) => (
          <a key={r.id} href={auditHref({ ...search, range: r.id, cursor: '', to: '' })} className={r.id === search.range ? 'on' : undefined} aria-current={r.id === search.range ? 'true' : undefined}>
            {r.id}
          </a>
        ))}
      </nav>
      <nav className={className} aria-label="การกระทำ">
        {AUDIT_FAMILIES.map((f) => (
          <a key={f.id || 'all'} href={auditHref({ ...search, family: f.id, cursor: '' })} className={f.id === search.family ? 'on' : undefined} aria-current={f.id === search.family ? 'true' : undefined}>
            {f.label}
          </a>
        ))}
      </nav>
    </>
  );
}

function Pager({ page, search, older }: { page: AuditPage; search: AuditSearch; older: string | null }) {
  return (
    <nav className="lg-pager" aria-label="หน้าประวัติ">
      <span className="dim">แสดง {page.events.length} รายการ ใหม่สุดก่อน</span>
      {search.cursor && <a href={auditHref({ ...search, cursor: '' })}>← กลับหน้าแรก</a>}
      {older && <a href={older}>เก่ากว่า →</a>}
    </nav>
  );
}

function stats(events: AuditEvent[]) {
  return {
    total: events.length,
    stations: events.filter((e) => fam(e) === 'station').length,
    roles: events.filter((e) => fam(e) === 'staff_role').length,
    people: new Set(events.map((e) => e.actor)).size,
  };
}

/** Groups consecutive events by Thailand calendar day. */
function byDay(events: AuditEvent[]) {
  const groups: { day: string; events: AuditEvent[] }[] = [];
  for (const e of events) {
    const day = formatDay(e.occurredAt);
    if (groups[groups.length - 1]?.day !== day) groups.push({ day, events: [] });
    groups[groups.length - 1].events.push(e);
  }
  return groups;
}

function Fields({ e }: { e: AuditEvent }) {
  const rows: [string, React.ReactNode][] = [
    ['เวลา', `${formatLogTime(e.occurredAt)} (${e.occurredAt})`],
    ['การกระทำ', `${actionLabel(e.action)} (${e.action})`],
    ['ผู้กระทำ', `${actorName(e)} (${e.actor})`],
    ['เป้าหมาย', <Target key="t" e={e} />],
    ['เหตุผล', e.reason ?? '—'],
    ['สิ่งที่เปลี่ยน', changeSummary(e) || '—'],
    ['requestId', e.requestId ?? '—'],
  ];
  return (
    <dl className="adm-panel lg-fields">
      {rows.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function WorkbenchAudit({ page, search, older }: { page: AuditPage; search: AuditSearch; older: string | null }) {
  const [cursor, setCursor] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  const events = page.events;
  const sel = events[cursor];
  useEffect(() => {
    function onKey(ev: KeyboardEvent) {
      const t = ev.target as HTMLElement;
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) || ev.metaKey || ev.ctrlKey || ev.altKey) return;
      if (ev.key === 'j') setCursor((c) => Math.min(c + 1, events.length - 1));
      else if (ev.key === 'k') setCursor((c) => Math.max(c - 1, 0));
      else return;
      ev.preventDefault();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [events.length]);
  useEffect(() => {
    listRef.current?.querySelectorAll('li')[cursor]?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);
  return (
    <div className="split">
      <section className="list" aria-label="รายการประวัติ">
        <div className="lh">
          <h3>
            ประวัติการแก้ไข <span>{events.length}</span>
          </h3>
          <SearchForm search={search} className="wb-search" />
        </div>
        {events.length === 0 ? (
          <Empty />
        ) : (
          <ul ref={listRef}>
            {events.map((e, i) => (
              <li key={e.id} className={`it au-it${i === cursor ? ' sel' : ''}`}>
                <i className={`ic au-ic ${fam(e)}`} aria-hidden="true" />
                <button type="button" className="lg-pick" onClick={() => setCursor(i)} aria-pressed={i === cursor}>
                  <b>{actionLabel(e.action)}</b>
                </button>
                <span className="r">{formatLogTime(e.occurredAt).split(' ').pop()}</span>
                <small>
                  {actorName(e)} · {formatLogTime(e.occurredAt)}
                </small>
              </li>
            ))}
          </ul>
        )}
        <div className="foot">
          <kbd>j</kbd> <kbd>k</kbd> เลื่อน · {search.cursor && <a href={auditHref({ ...search, cursor: '' })}>หน้าแรก</a>} {older && <a href={older}>เก่ากว่า →</a>}
        </div>
      </section>
      <section className="det" aria-label="รายละเอียด">
        {sel ? (
          <div className="lg-detail">
            <p className="crumb">ประวัติการแก้ไข /</p>
            <h2>{actionLabel(sel.action)}</h2>
            <p className="dim">{NOTE}</p>
            <Fields e={sel} />
            <a className="btn secondary" href={auditHref({ ...search, actor: actorKey(sel), cursor: '', to: '' })}>
              ดูทุกอย่างที่ {actorName(sel)} ทำ
            </a>
          </div>
        ) : (
          <p className="adm-empty">เลือกรายการจากทางซ้าย</p>
        )}
      </section>
    </div>
  );
}

export function AuditView({ page, status, badField, search, older }: AuditViewProps) {
  const { theme } = useAdmin();
  const s = page ? stats(page.events) : null;
  const body = (render: (p: AuditPage) => React.ReactNode) => (!page ? <Problem status={status} badField={badField} /> : page.events.length === 0 ? <Empty /> : render(page));
  const latest = auditHref({ ...search, to: '', cursor: '' });

  if (theme === 'workbench') {
    return page ? (
      <WorkbenchAudit page={page} search={search} older={older} />
    ) : (
      <div className="det">
        <Problem status={status} badField={badField} />
      </div>
    );
  }

  if (theme === 'control-room') {
    return (
      <div className="cr-page logs audit">
        <div className="top">
          <div className="crumb">
            Security<b>ประวัติการแก้ไข</b>
          </div>
          <Pickers search={search} className="seg" />
          <a className="btn secondary" href={latest}>
            ↻ ล่าสุด
          </a>
        </div>
        <SearchForm search={search} className="cr-filter" pickers={false} />
        <div className="pn lg-pn">
          {body((p) => (
            <table>
              <caption className="sr-only">ประวัติการแก้ไข ใหม่สุดก่อน</caption>
              <thead>
                <tr>
                  <th scope="col">เวลา (ไทย)</th>
                  <th scope="col">ผู้กระทำ</th>
                  <th scope="col">การกระทำ</th>
                  <th scope="col">เป้าหมาย</th>
                  <th scope="col">เหตุผล</th>
                  <th scope="col">สิ่งที่เปลี่ยน</th>
                  <th scope="col">requestId</th>
                </tr>
              </thead>
              <tbody>
                {p.events.map((e) => (
                  <tr key={e.id}>
                    <td className="mo nowrap">{formatLogTime(e.occurredAt)}</td>
                    <td className="nowrap">
                      <ActorLink e={e} search={search} />
                    </td>
                    <td className="nowrap">
                      <span className={`tag au-${fam(e)}`}>{actionLabel(e.action)}</span>
                    </td>
                    <td className="mo nowrap">
                      <Target e={e} />
                    </td>
                    <td>{e.reason ?? <span className="dim">—</span>}</td>
                    <td className="dim">{changeSummary(e)}</td>
                    <td className="mo dim nowrap">{e.requestId ? shortId(e.requestId) : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ))}
        </div>
        {page && (
          <p className="note">
            {s!.total} events · catalog {s!.stations} · roles {s!.roles} · actors {s!.people} · {NOTE}
            {older && (
              <>
                {' · '}
                <a href={older}>older →</a>
              </>
            )}
          </p>
        )}
      </div>
    );
  }

  if (theme === 'broadcast-rack') {
    return (
      <div className="br-page logs audit">
        <div className="ttl">
          <h3>ประวัติการแก้ไข · Logbook</h3>
          <span>{NOTE}</span>
          <a className="btn" href={latest}>
            ล่าสุด
          </a>
        </div>
        <div className="br-pick">
          <Pickers search={search} className="knobs" />
        </div>
        <SearchForm search={search} className="adm-panel br-filter" pickers={false} />
        {body((p) => (
          <ol className="br-book" aria-label="ประวัติการแก้ไข ใหม่สุดก่อน">
            {p.events.map((e) => (
              <li key={e.id} className={fam(e)}>
                <span className="no">#{e.id.padStart(4, '0')}</span>
                <span className="t">{formatLogTime(e.occurredAt)}</span>
                <b>
                  <i className={`lamp au-${fam(e)}`} aria-hidden="true" />
                  {actionLabel(e.action)}
                </b>
                <span className="who">
                  โดย <ActorLink e={e} search={search} /> · <Target e={e} />
                </span>
                {(e.reason || changeSummary(e)) && (
                  <span className="why">
                    {e.reason && <q>{e.reason}</q>} {changeSummary(e)}
                  </span>
                )}
              </li>
            ))}
          </ol>
        ))}
        {page && <Pager page={page} search={search} older={older} />}
      </div>
    );
  }

  if (theme === 'daylight-bento') {
    return (
      <div className="db-page logs audit">
        <div className="hello">
          <div>
            <h3>ประวัติการแก้ไข</h3>
            <p>{NOTE}</p>
          </div>
          <a className="btn" href={latest}>
            โหลดล่าสุด
          </a>
        </div>
        <div className="search">
          <Pickers search={search} className="chips" />
        </div>
        {s && (
          <div className="db-stats" aria-label="สรุปรายการในหน้านี้">
            <div>
              <small>รายการในหน้านี้</small>
              <b>{s.total}</b>
            </div>
            <div>
              <small>เกี่ยวกับสถานี</small>
              <b>{s.stations}</b>
            </div>
            <div className="w">
              <small>เปลี่ยนสิทธิ์ทีมงาน</small>
              <b>{s.roles}</b>
            </div>
            <div>
              <small>คนที่เกี่ยวข้อง</small>
              <b>{s.people}</b>
            </div>
          </div>
        )}
        <SearchForm search={search} className="adm-panel db-filter" pickers={false} />
        {body((p) => (
          <div className="db-days">
            {byDay(p.events).map((g) => (
              <section key={g.day} aria-label={g.day}>
                <h4>{g.day}</h4>
                <ul className="db-logs au-cards">
                  {g.events.map((e) => (
                    <li key={e.id} className={fam(e)}>
                      <span className={`pill au-pill ${fam(e)}`}>{actionLabel(e.action)}</span>
                      <b>
                        <ActorLink e={e} search={search} /> · <Target e={e} />
                      </b>
                      <span className="mo st">{formatLogTime(e.occurredAt).split(' ').pop()}</span>
                      <small>
                        {e.reason && <q>{e.reason}</q>} {changeSummary(e)}
                      </small>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        ))}
        {page && <Pager page={page} search={search} older={older} />}
      </div>
    );
  }

  // Minimal (FinVault cards)
  return (
    <div className="fv-dash logs audit">
      {s && (
        <div className="fv-logstats">
          <section className="fv-card">
            <small className="fv-label">รายการในหน้านี้</small>
            <p className="fv-amount">{s.total}</p>
            <small>{AUDIT_RANGES.find((r) => r.id === search.range)?.label}</small>
          </section>
          <section className="fv-card">
            <small className="fv-label">เกี่ยวกับสถานี</small>
            <p className="fv-amount">{s.stations}</p>
            <small>สร้าง แก้ เผยแพร่ ปิด</small>
          </section>
          <section className={`fv-card${s.roles ? ' rose' : ''}`}>
            <small className="fv-label">เปลี่ยนสิทธิ์ทีมงาน</small>
            <p className="fv-amount">{s.roles}</p>
            <small>ให้หรือถอนบทบาท</small>
          </section>
          <section className="fv-card">
            <small className="fv-label">คนที่เกี่ยวข้อง</small>
            <p className="fv-amount">{s.people}</p>
            <small>บัญชีและโอเปอเรเตอร์</small>
          </section>
        </div>
      )}
      <section className="fv-card" aria-labelledby="fv-auditsearch">
        <div className="fv-card-head">
          <div>
            <h2 id="fv-auditsearch">ประวัติการแก้ไข</h2>
            <small>{NOTE}</small>
          </div>
          <a className="fv-ghost lg-latest" href={latest}>
            <Icon name="audit" /> โหลดล่าสุด
          </a>
        </div>
        <SearchForm search={search} className="lg-filters fv-logform" />
      </section>
      <section className="fv-card" aria-label="ผลการค้นหา">
        {body((p) => (
          <ul className="fv-tx au-feed">
            {p.events.map((e) => (
              <li key={e.id}>
                <span className={`fv-tile au-${fam(e)}`} aria-hidden="true">
                  <Icon name={fam(e) === 'station' ? 'radio' : fam(e) === 'staff_role' ? 'me' : 'search'} />
                </span>
                <span className="fv-tx-main">
                  <b>
                    {actionLabel(e.action)} · <Target e={e} />
                  </b>
                  <small>
                    {e.reason ? `“${e.reason}” · ` : ''}
                    {changeSummary(e)}
                  </small>
                </span>
                <span className="fv-tx-side">
                  <b>
                    <ActorLink e={e} search={search} />
                  </b>
                  <small>{formatLogTime(e.occurredAt)}</small>
                </span>
              </li>
            ))}
          </ul>
        ))}
      </section>
      {page && <Pager page={page} search={search} older={older} />}
    </div>
  );
}
