'use client';

import { useEffect, useRef, useState } from 'react';
import { formatLogTime, RATE_LIMITED, LOG_FIELD_LABELS, LOG_LEVELS, LOG_RANGES, logApiParams, logHref, LogSearch } from '@/lib/admin';
import type { LogEntry, LogPage } from '@/lib/bff';
import { Icon, useAdmin } from '../AdminShell';
import { CsvExport } from '../CsvExport';

/**
 * Staff log search (Doc 17 /admin/logs). Data and filters are shared; each theme lays the page out
 * its own way (Tar, 2026-10-03). Plain text only, no auto-refresh.
 */
export interface LogsViewProps {
  page?: LogPage;
  status: number;
  badField?: string;
  search: LogSearch;
  older: string | null;
}

const shortId = (v: string) => (v.length > 14 ? `${v.slice(0, 6)}…${v.slice(-6)}` : v);
const sev = (l: LogEntry) => l.severity.toLowerCase();
const what = (l: LogEntry) => (l.method ? `${l.method} ${l.route ?? ''}` : (l.errorName ?? ''));
const requestHref = (s: LogSearch, requestId: string) => logHref({ ...s, requestId, cursor: '', to: '', range: '24h' });
/** Every line of one trace (console BFF and API) in the last 24 hours, whatever the other filters were. */
const traceHref = (traceId: string) => logHref({ traceId, range: '24h' });

function stats(logs: LogEntry[]) {
  const timed = logs.filter((l) => l.durationMs !== null);
  return {
    total: logs.length,
    warn: logs.filter((l) => l.severity === 'WARN').length,
    error: logs.filter((l) => l.severity === 'ERROR').length,
    avgMs: timed.length ? Math.round(timed.reduce((a, l) => a + (l.durationMs ?? 0), 0) / timed.length) : null,
  };
}

function Problem({ status, badField }: { status: number; badField?: string }) {
  return (
    <div className="adm-alert" role="alert">
      {status === 403
        ? 'บัญชีนี้ไม่มีสิทธิ์ดูบันทึกระบบ (ต้องเป็นโอเปอเรเตอร์หรือแอดมิน)'
        : status === 400
          ? `ค่าที่กรอกไม่ถูกต้อง: ${badField ? (LOG_FIELD_LABELS[badField] ?? badField) : 'ตัวกรอง'}`
          : status === 429
            ? RATE_LIMITED
            : 'โหลดบันทึกไม่ได้ในขณะนี้ ลองใหม่อีกครั้ง'}
    </div>
  );
}

const Empty = () => <p className="adm-empty">ไม่พบบันทึกตามเงื่อนไขนี้ในช่วงเวลาที่เลือก</p>;

/** The search form. `pickers` false: range and level are chosen with links elsewhere and kept here as hidden fields. */
function SearchForm({ search, className, pickers = true, compact = false }: { search: LogSearch; className: string; pickers?: boolean; compact?: boolean }) {
  return (
    <form className={className} method="get" action="/admin/logs" aria-label="ค้นหาบันทึก">
      {pickers ? (
        <>
          <label className="fld">
            <span>ช่วงเวลา</span>
            <select name="range" defaultValue={search.range}>
              {LOG_RANGES.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>
          <label className="fld">
            <span>ระดับ</span>
            <select name="level" defaultValue={search.level}>
              {LOG_LEVELS.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.label}
                </option>
              ))}
            </select>
          </label>
        </>
      ) : (
        <>
          <input type="hidden" name="range" value={search.range} />
          <input type="hidden" name="level" value={search.level} />
        </>
      )}
      <label className="fld wide">
        <span>requestId</span>
        <input name="requestId" defaultValue={search.requestId} maxLength={64} placeholder="req_… หรือ web_…" />
      </label>
      <label className="fld">
        <span>HTTP status</span>
        <input name="status" defaultValue={search.status} inputMode="numeric" maxLength={3} placeholder="เช่น 500" />
      </label>
      <label className="fld">
        <span>รหัสข้อผิดพลาด</span>
        <input name="errorCode" defaultValue={search.errorCode} maxLength={64} placeholder="IDP_DELETE_FAILED" />
      </label>
      <label className="fld wide">
        <span>traceId</span>
        <input name="traceId" defaultValue={search.traceId} maxLength={32} placeholder="32 ตัวอักษร 0-9 a-f" spellCheck={false} />
      </label>
      {!compact && (
        <>
          <label className="fld">
            <span>รหัสเหตุการณ์</span>
            <input name="eventCode" defaultValue={search.eventCode} maxLength={64} placeholder="HTTP_REQUEST" />
          </label>
          <label className="fld">
            <span>build</span>
            <input name="build" defaultValue={search.build} maxLength={64} />
          </label>
        </>
      )}
      {compact && (
        <>
          <input type="hidden" name="eventCode" value={search.eventCode} />
          <input type="hidden" name="build" value={search.build} />
        </>
      )}
      <div className="lg-actions">
        <button type="submit" className="btn">
          ค้นหา
        </button>
        <a href="/admin/logs" className="adm-link">
          ล้างตัวกรอง
        </a>
      </div>
    </form>
  );
}

/** Range and level as links (segments, knobs, chips). */
function Pickers({ search, className }: { search: LogSearch; className: string }) {
  return (
    <>
      <nav className={className} aria-label="ช่วงเวลา">
        {LOG_RANGES.map((r) => (
          <a key={r.id} href={logHref({ ...search, range: r.id, cursor: '', to: '' })} className={r.id === search.range ? 'on' : undefined} aria-current={r.id === search.range ? 'true' : undefined}>
            {r.id}
          </a>
        ))}
      </nav>
      <nav className={className} aria-label="ระดับ">
        {LOG_LEVELS.map((l) => (
          <a key={l.id || 'all'} href={logHref({ ...search, level: l.id, cursor: '' })} className={l.id === search.level ? 'on' : undefined} aria-current={l.id === search.level ? 'true' : undefined}>
            {l.label}
          </a>
        ))}
      </nav>
    </>
  );
}

/** Doc 17 log export: the current search as CSV, with a reason and recent MFA. Each theme places the button. */
function ExportPanel({ search, className }: { search: LogSearch; className?: string }) {
  const { cursor: _c, limit: _l, ...params } = logApiParams({ ...search, cursor: '' });
  return (
    <CsvExport
      endpoint="/bff/admin/logs/export"
      params={params}
      forbidden="ส่งออกได้เฉพาะโอเปอเรเตอร์หรือแอดมิน"
      formLabel="ส่งออกบันทึกระบบ"
      unit="บรรทัด"
      fallbackName="tunedeck-logs.csv"
      className={className}
    />
  );
}

function Pager({ page, search, older, className = 'lg-pager' }: { page: LogPage; search: LogSearch; older: string | null; className?: string }) {
  return (
    <nav className={className} aria-label="หน้าบันทึก">
      <span className="dim">แสดง {page.logs.length} บรรทัด ใหม่สุดก่อน</span>
      {search.cursor && <a href={logHref({ ...search, cursor: '' })}>← กลับหน้าแรก</a>}
      {older && <a href={older}>เก่ากว่า →</a>}
    </nav>
  );
}

function LogTable({ logs, search }: { logs: LogEntry[]; search: LogSearch }) {
  return (
    <table>
      <caption className="sr-only">บันทึกระบบ ใหม่สุดก่อน</caption>
      <thead>
        <tr>
          <th scope="col">เวลา (ไทย)</th>
          <th scope="col">ระดับ</th>
          <th scope="col">เหตุการณ์</th>
          <th scope="col">คำขอ</th>
          <th scope="col" className="num">
            status
          </th>
          <th scope="col" className="num">
            ใช้เวลา
          </th>
          <th scope="col">requestId</th>
          <th scope="col">traceId</th>
          <th scope="col">ผู้ใช้</th>
          <th scope="col">build / error</th>
        </tr>
      </thead>
      <tbody>
        {logs.map((l) => (
          <tr key={l.id} className={`lg-${sev(l)}`}>
            <td className="mo nowrap">{formatLogTime(l.timestamp)}</td>
            <td>
              <span className={`lg-sev ${sev(l)}`}>{l.severity}</span>
            </td>
            <td className="mo nowrap">{l.eventCode}</td>
            <td className="mo lg-route">{what(l)}</td>
            <td className="mo num">{l.status ?? ''}</td>
            <td className="mo num">{l.durationMs !== null ? `${l.durationMs} ms` : ''}</td>
            <td className="mo nowrap">
              {l.requestId && (
                <a href={requestHref(search, l.requestId)} title={`ดูทุกบรรทัดของ ${l.requestId}`}>
                  {shortId(l.requestId)}
                </a>
              )}
            </td>
            <td className="mo nowrap">
              {l.traceId && (
                <a href={traceHref(l.traceId)} title={`ดูทุกบรรทัดของ trace ${l.traceId}`}>
                  {shortId(l.traceId)}
                </a>
              )}
            </td>
            <td className="mo dim nowrap" title={l.actorId ?? undefined}>
              {l.actorId ? shortId(l.actorId) : ''}
            </td>
            <td className="mo dim">{l.errorCode ?? l.build}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const RETENTION_NOTE = 'ตัดข้อมูลลับออกแล้ว เก็บ 14 วัน ค้นได้ทีละไม่เกิน 24 ชั่วโมง ทุกการค้นหาและการส่งออกถูกบันทึกใน audit';

/** Workbench: line list with j/k on the left, every field of the chosen line on the right. */
function WorkbenchLogs({ page, search, older }: { page: LogPage; search: LogSearch; older: string | null }) {
  const [cursor, setCursor] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  const logs = page.logs;
  const sel = logs[cursor];
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement;
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'j') setCursor((c) => Math.min(c + 1, logs.length - 1));
      else if (e.key === 'k') setCursor((c) => Math.max(c - 1, 0));
      else return;
      e.preventDefault();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [logs.length]);
  useEffect(() => {
    listRef.current?.querySelectorAll('li')[cursor]?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);
  const fields: [string, string | number | null][] = sel
    ? [
        ['เวลา', `${formatLogTime(sel.timestamp)} (${sel.timestamp})`],
        ['ระดับ', sel.severity],
        ['เหตุการณ์', sel.eventCode],
        ['method', sel.method],
        ['route', sel.route],
        ['status', sel.status],
        ['ใช้เวลา', sel.durationMs !== null ? `${sel.durationMs} ms` : null],
        ['requestId', sel.requestId],
        ['traceId', sel.traceId],
        ['ผู้ใช้ (id ภายใน)', sel.actorId],
        ['error', [sel.errorName, sel.errorCode].filter(Boolean).join(' · ') || null],
        ['service', sel.service],
        ['environment', sel.environment],
        ['build', sel.build],
      ]
    : [];
  return (
    <div className="split">
      <section className="list" aria-label="รายการบันทึก">
        <div className="lh">
          <h3>
            บันทึกระบบ <span>{logs.length}</span>
          </h3>
          <SearchForm search={search} className="wb-search" compact />
          <ExportPanel search={search} />
        </div>
        {logs.length === 0 ? (
          <Empty />
        ) : (
          <ul ref={listRef}>
            {logs.map((l, i) => (
              <li key={l.id} className={`it lg-it${i === cursor ? ' sel' : ''}`}>
                <i className={`ic lg-ic ${sev(l)}`} aria-hidden="true" />
                <button type="button" className="lg-pick" onClick={() => setCursor(i)} aria-pressed={i === cursor}>
                  <b className="mo">{what(l) || l.eventCode}</b>
                </button>
                <span className="r">{l.status ?? l.severity}</span>
                <small>
                  {formatLogTime(l.timestamp)} · {l.durationMs !== null ? `${l.durationMs} ms` : l.eventCode}
                </small>
              </li>
            ))}
          </ul>
        )}
        <div className="foot">
          <kbd>j</kbd> <kbd>k</kbd> เลื่อน · {search.cursor && <a href={logHref({ ...search, cursor: '' })}>หน้าแรก</a>} {older && <a href={older}>เก่ากว่า →</a>}
        </div>
      </section>
      <section className="det" aria-label="รายละเอียดบรรทัด">
        {sel ? (
          <div className="lg-detail">
            <p className="crumb">บันทึกระบบ /</p>
            <h2 className="mo">{what(sel) || sel.eventCode}</h2>
            <p className="dim">
              <span className={`lg-sev ${sev(sel)}`}>{sel.severity}</span> {RETENTION_NOTE}
            </p>
            <dl className="adm-panel lg-fields">
              {fields.map(([k, v]) => (
                <div key={k}>
                  <dt>{k}</dt>
                  <dd className="mo">{v ?? '—'}</dd>
                </div>
              ))}
            </dl>
            {sel.requestId && (
              <a className="btn secondary" href={requestHref(search, sel.requestId)}>
                ดูทุกบรรทัดของคำขอนี้
              </a>
            )}{' '}
            {sel.traceId && (
              <a className="btn secondary" href={traceHref(sel.traceId)}>
                ดูทั้ง trace (เว็บและ API)
              </a>
            )}
          </div>
        ) : (
          <p className="adm-empty">เลือกบรรทัดจากรายการทางซ้าย</p>
        )}
      </section>
    </div>
  );
}

export function LogsView({ page, status, badField, search, older }: LogsViewProps) {
  const { theme } = useAdmin();
  const s = page ? stats(page.logs) : null;
  const body = (render: (p: LogPage) => React.ReactNode) => (!page ? <Problem status={status} badField={badField} /> : page.logs.length === 0 ? <Empty /> : render(page));
  const latest = logHref({ ...search, to: '', cursor: '' });

  if (theme === 'workbench') {
    return page ? <WorkbenchLogs page={page} search={search} older={older} /> : <div className="det"><Problem status={status} badField={badField} /></div>;
  }

  if (theme === 'control-room') {
    return (
      <div className="cr-page logs">
        <div className="top">
          <div className="crumb">
            Ops<b>บันทึกระบบ</b>
          </div>
          <Pickers search={search} className="seg" />
          <a className="btn secondary" href={latest}>
            ↻ ล่าสุด
          </a>
          <ExportPanel search={search} />
        </div>
        <SearchForm search={search} className="cr-filter" pickers={false} />
        <div className="pn lg-pn">{body((p) => <LogTable logs={p.logs} search={search} />)}</div>
        {page && (
          <p className="note">
            {s!.total} lines · WARN {s!.warn} · ERROR {s!.error} · avg {s!.avgMs ?? '—'} ms · {RETENTION_NOTE}
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
      <div className="br-page logs">
        <div className="ttl">
          <h3>บันทึกระบบ · Monitor</h3>
          <span>{RETENTION_NOTE}</span>
          <a className="btn" href={latest}>
            ล่าสุด
          </a>
          <ExportPanel search={search} />
        </div>
        <div className="br-pick">
          <Pickers search={search} className="knobs" />
        </div>
        <SearchForm search={search} className="adm-panel br-filter" pickers={false} />
        {body((p) => (
          <ol className="br-tape" aria-label="บันทึกระบบ ใหม่สุดก่อน">
            {p.logs.map((l) => (
              <li key={l.id} className={sev(l)}>
                <i className={`lamp lg-${sev(l)}`} aria-hidden="true" />
                <span className="t">{formatLogTime(l.timestamp)}</span>
                <span className="sv">{l.severity}</span>
                <span className="w">{what(l) || l.eventCode}</span>
                <span className="n">{l.status ?? ''}</span>
                <span className="n">{l.durationMs !== null ? `${l.durationMs}ms` : ''}</span>
                {l.requestId ? (
                  <a href={requestHref(search, l.requestId)} title={`ดูทุกบรรทัดของ ${l.requestId}`}>
                    {shortId(l.requestId)}
                  </a>
                ) : (
                  <span />
                )}
                {l.traceId ? (
                  <a href={traceHref(l.traceId)} title={`ดูทุกบรรทัดของ trace ${l.traceId}`}>
                    tr {shortId(l.traceId)}
                  </a>
                ) : (
                  <span />
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
      <div className="db-page logs">
        <div className="hello">
          <div>
            <h3>บันทึกระบบ</h3>
            <p>{RETENTION_NOTE}</p>
          </div>
          <div className="db-actions">
            <a className="btn" href={latest}>
              โหลดล่าสุด
            </a>
            <ExportPanel search={search} />
          </div>
        </div>
        <div className="search">
          <Pickers search={search} className="chips" />
        </div>
        {s && (
          <div className="db-stats" aria-label="สรุปบรรทัดในหน้านี้">
            <div>
              <small>บรรทัดในหน้านี้</small>
              <b>{s.total}</b>
            </div>
            <div className="w">
              <small>WARN</small>
              <b>{s.warn}</b>
            </div>
            <div className="e">
              <small>ERROR</small>
              <b>{s.error}</b>
            </div>
            <div>
              <small>เวลาเฉลี่ย</small>
              <b>{s.avgMs ?? '—'} ms</b>
            </div>
          </div>
        )}
        <SearchForm search={search} className="adm-panel db-filter" pickers={false} />
        {body((p) => (
          <ul className="db-logs">
            {p.logs.map((l) => (
              <li key={l.id} className={sev(l)}>
                <span className={`pill lg-pill ${sev(l)}`}>{l.severity}</span>
                <b className="mo">{what(l) || l.eventCode}</b>
                <span className="mo st">{l.status ?? ''}</span>
                <small>
                  {formatLogTime(l.timestamp)}
                  {l.durationMs !== null && ` · ${l.durationMs} ms`}
                  {l.requestId && (
                    <>
                      {' · '}
                      <a href={requestHref(search, l.requestId)}>{shortId(l.requestId)}</a>
                    </>
                  )}
                  {l.traceId && (
                    <>
                      {' · trace '}
                      <a href={traceHref(l.traceId)}>{shortId(l.traceId)}</a>
                    </>
                  )}
                </small>
              </li>
            ))}
          </ul>
        ))}
        {page && <Pager page={page} search={search} older={older} />}
      </div>
    );
  }

  // Minimal (FinVault cards)
  return (
    <div className="fv-dash logs">
      {s && (
        <div className="fv-logstats">
          <section className="fv-card">
            <small className="fv-label">บรรทัดในหน้านี้</small>
            <p className="fv-amount">{s.total}</p>
            <small>{LOG_RANGES.find((r) => r.id === search.range)?.label}</small>
          </section>
          <section className="fv-card">
            <small className="fv-label">WARN</small>
            <p className="fv-amount hot">{s.warn}</p>
            <small>4xx และคำเตือน</small>
          </section>
          <section className={`fv-card${s.error ? ' rose' : ''}`}>
            <small className="fv-label">ERROR</small>
            <p className="fv-amount">{s.error}</p>
            <small>5xx และข้อผิดพลาด</small>
          </section>
          <section className="fv-card">
            <small className="fv-label">เวลาตอบเฉลี่ย</small>
            <p className="fv-amount">{s.avgMs ?? '—'} ms</p>
            <small>เฉพาะคำขอ HTTP</small>
          </section>
        </div>
      )}
      <section className="fv-card" aria-labelledby="fv-logsearch">
        <div className="fv-card-head">
          <div>
            <h2 id="fv-logsearch">บันทึกระบบ</h2>
            <small>{RETENTION_NOTE}</small>
          </div>
          <div className="fv-actions">
            <a className="fv-ghost lg-latest" href={latest}>
              <Icon name="bolt" /> โหลดล่าสุด
            </a>
            <ExportPanel search={search} className="fv-ghost" />
          </div>
        </div>
        <SearchForm search={search} className="lg-filters fv-logform" />
      </section>
      <section className="fv-card lg-table" aria-label="ผลการค้นหา">
        {body((p) => <LogTable logs={p.logs} search={search} />)}
      </section>
      {page && <Pager page={page} search={search} older={older} />}
    </div>
  );
}
