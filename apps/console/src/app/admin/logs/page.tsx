import { redirect } from 'next/navigation';
import { formatLogTime, LOG_FIELD_LABELS, LOG_LEVELS, LOG_RANGES, logApiParams, logHref, LogSearch, logSearchFrom } from '@/lib/admin';
import type { LogEntry } from '@/lib/bff';
import { staffPage } from '../stations/load';

export const dynamic = 'force-dynamic';

const shortId = (v: string) => (v.length > 14 ? `${v.slice(0, 6)}…${v.slice(-6)}` : v);

function Row({ l, search }: { l: LogEntry; search: LogSearch }) {
  return (
    <tr className={`lg-${l.severity.toLowerCase()}`}>
      <td className="mo nowrap">{formatLogTime(l.timestamp)}</td>
      <td>
        <span className={`lg-sev ${l.severity.toLowerCase()}`}>{l.severity}</span>
      </td>
      <td className="mo nowrap">{l.eventCode}</td>
      <td className="mo lg-route">{l.method ? `${l.method} ${l.route ?? ''}` : (l.errorName ?? '')}</td>
      <td className="mo num">{l.status ?? ''}</td>
      <td className="mo num">{l.durationMs !== null ? `${l.durationMs} ms` : ''}</td>
      <td className="mo nowrap">
        {l.requestId ? (
          <a href={logHref({ ...search, requestId: l.requestId, cursor: '', to: '', range: '7d' })} title={`ดูทุกบรรทัดของ ${l.requestId}`}>
            {shortId(l.requestId)}
          </a>
        ) : (
          ''
        )}
      </td>
      <td className="mo dim nowrap" title={l.actorId ?? undefined}>
        {l.actorId ? shortId(l.actorId) : ''}
      </td>
      <td className="mo dim">{l.errorCode ?? l.build}</td>
    </tr>
  );
}

/** Staff log search (Doc 17 /admin/logs): bounded filters, plain text only, no auto-refresh. Every search is audited by the API. */
export default async function LogsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { bff, ctx } = await staffPage('/admin/logs');
  const search = logSearchFrom(await searchParams);
  const result = await bff.loadLogs(ctx, logApiParams(search)).catch(() => ({ status: 503 }) as const);
  if (result === null) redirect('/login?expired=1&returnTo=/admin/logs');
  const page = 'page' in result ? result.page : undefined;
  const badField = 'field' in result ? result.field : undefined;
  const pinnedTo = search.to || (page ? new Date().toISOString() : '');
  const older = page?.nextCursor ? logHref({ ...search, to: pinnedTo, cursor: page.nextCursor }) : null;

  return (
    <div className="logs">
      <header className="lg-head">
        <div>
          <h2>บันทึกระบบ</h2>
          <p className="dim">
            Log ของ API ตัดข้อมูลลับออกแล้ว เก็บ {page?.retentionDays ?? 14} วัน ค้นได้ทีละไม่เกิน 7 วัน ทุกการค้นหาถูกบันทึกใน audit
          </p>
        </div>
        <a className="btn secondary" href={logHref({ ...search, to: '', cursor: '' })}>
          โหลดล่าสุด
        </a>
      </header>

      <form className="lg-filters adm-panel" method="get" action="/admin/logs" aria-label="ค้นหาบันทึก">
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
        <label className="fld">
          <span>HTTP status</span>
          <input name="status" defaultValue={search.status} inputMode="numeric" maxLength={3} placeholder="เช่น 500" />
        </label>
        <label className="fld">
          <span>รหัสเหตุการณ์</span>
          <input name="eventCode" defaultValue={search.eventCode} maxLength={64} placeholder="HTTP_REQUEST" />
        </label>
        <label className="fld wide">
          <span>requestId</span>
          <input name="requestId" defaultValue={search.requestId} maxLength={64} placeholder="req_… หรือ web_…" />
        </label>
        <label className="fld">
          <span>build</span>
          <input name="build" defaultValue={search.build} maxLength={64} />
        </label>
        <div className="lg-actions">
          <button type="submit" className="btn">
            ค้นหา
          </button>
          <a href="/admin/logs" className="adm-link">
            ล้างตัวกรอง
          </a>
        </div>
      </form>

      {!page ? (
        <div className="adm-alert" role="alert">
          {result.status === 403
            ? 'บัญชีนี้ไม่มีสิทธิ์ดูบันทึกระบบ (ต้องเป็นโอเปอเรเตอร์หรือแอดมิน)'
            : result.status === 400
              ? `ค่าที่กรอกไม่ถูกต้อง: ${badField ? (LOG_FIELD_LABELS[badField] ?? badField) : 'ตัวกรอง'}`
              : 'โหลดบันทึกไม่ได้ในขณะนี้ ลองใหม่อีกครั้ง'}
        </div>
      ) : page.logs.length === 0 ? (
        <p className="adm-empty">ไม่พบบันทึกตามเงื่อนไขนี้ในช่วงเวลาที่เลือก</p>
      ) : (
        <div className="lg-table adm-panel">
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
                <th scope="col">ผู้ใช้</th>
                <th scope="col">build / error</th>
              </tr>
            </thead>
            <tbody>
              {page.logs.map((l) => (
                <Row key={l.id} l={l} search={search} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {page && (
        <nav className="lg-pager" aria-label="หน้าบันทึก">
          <span className="dim">แสดง {page.logs.length} บรรทัด ใหม่สุดก่อน</span>
          {search.cursor && <a href={logHref({ ...search, cursor: '' })}>← กลับหน้าแรก</a>}
          {older && <a href={older}>เก่ากว่า →</a>}
        </nav>
      )}
    </div>
  );
}
