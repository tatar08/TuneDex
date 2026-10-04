'use client';

import { useRouter } from 'next/navigation';
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { formatLogTime, RATE_LIMITED } from '@/lib/admin';
import type { Job, JobFilter, JobKind, JobsPage, JobStatus, QueueSummary } from '@/lib/bff';
import { useAdmin } from '../AdminShell';

/**
 * Background jobs (Doc 17 /admin/jobs): every queue (account deletion, account export, Keycloak session end),
 * what is queued, how old it is, attempts, next attempt, last error code, and an authorized retry with a
 * recorded reason. A failed job retries by itself after 1, 5, 15 and 60 minutes; after 5 attempts it stops
 * (dead letter) and waits here for staff. "Retry now" on a dead letter starts a new round (3 per job a day).
 * Data is shared; each theme lays the page out its own way (Tar, 2026-10-03).
 */
const FILTERS: { id: JobFilter; label: string }[] = [
  { id: 'open', label: 'ค้างอยู่' },
  { id: 'failed', label: 'ไม่สำเร็จ' },
  { id: 'dead_letter', label: 'รอทีมงาน' },
  { id: 'completed', label: 'เสร็จแล้ว (7 วัน)' },
  { id: 'all', label: 'ทั้งหมด' },
];
const STATUS_LABEL: Record<JobStatus, string> = {
  pending: 'รอทำ',
  retrying: 'ไม่สำเร็จ กำลังลองใหม่อัตโนมัติ',
  dead_letter: 'ลองครบ 5 ครั้งแล้ว รอทีมงานสั่งลองใหม่',
  completed: 'เสร็จแล้ว',
};
const KIND_LABEL: Record<JobKind, string> = { account_deletion: 'ลบบัญชีผู้ใช้', account_export: 'ส่งออกข้อมูลบัญชี', idp_session_end: 'ปิดเซสชัน Keycloak' };
/** Where a failure is logged, per queue. */
const FAIL_EVENT: Record<JobKind, string> = { account_deletion: 'ACCOUNT_PURGE_FAILED', account_export: 'ACCOUNT_EXPORT_FAILED', idp_session_end: 'IDP_SESSION_END_FAILED' };
const DONE_FLASH: Record<JobKind, string> = { account_deletion: 'ลบข้อมูลบัญชีเสร็จแล้ว', account_export: 'สร้างไฟล์ส่งออกข้อมูลเสร็จแล้ว', idp_session_end: 'ปิดเซสชัน Keycloak แล้ว' };
const failing = (s: JobStatus) => s === 'retrying' || s === 'dead_letter';

function age(iso: string, now = Date.now()) {
  const m = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60_000));
  if (m < 60) return `${m} นาที`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} ชั่วโมง` : `${Math.round(h / 24)} วัน`;
}
/** Completion time, or the 30-day deadline for a deletion; other queues have no deadline. */
function due(job: Job, now = Date.now()) {
  if (job.status === 'completed') return job.completedAt ? `เสร็จ ${formatLogTime(job.completedAt)}` : 'เสร็จแล้ว';
  if (!job.deadline) return '—';
  const d = Math.ceil((new Date(job.deadline).getTime() - now) / 86_400_000);
  return d > 0 ? `ต้องเสร็จใน ${d} วัน` : 'เลยกำหนด 30 วันแล้ว';
}
const late = (job: Job) => job.status !== 'completed' && !!job.deadline && new Date(job.deadline).getTime() - Date.now() < 5 * 86_400_000;
/** When the worker tries next. */
function next(job: Job) {
  if (job.status === 'dead_letter') return 'หยุดลองแล้ว รอทีมงาน';
  if (job.status === 'completed') return '—';
  return job.nextAttemptAt ? formatLogTime(job.nextAttemptAt) : 'รอบถัดไป (ภายใน 1 นาที)';
}
const tries = (job: Job) => `${job.attempts}/${job.maxAttempts}`;
const errCode = (job: Job) => job.lastErrorCode ?? '—';
/** Job ids carry a kind prefix (ex_, se_); show the distinctive part. */
const shortId = (id: string) => id.replace(/^(ex|se)_/, '').slice(0, 8);

/** Each queue's counts and its oldest open job, for the summary in every theme. */
function queueLine(q: QueueSummary) {
  const parts = [`รอทำ ${q.pending}`, `ลองใหม่ ${q.retrying}`, `รอทีมงาน ${q.deadLetter}`];
  return `${parts.join(' · ')} · ค้างนานสุด ${q.oldestOpenAt ? age(q.oldestOpenAt) : '—'}`;
}

function Filters({ filter, className }: { filter: JobFilter; className: string }) {
  return (
    <nav className={className} aria-label="สถานะงาน">
      {FILTERS.map((f) => (
        <a key={f.id} href={f.id === 'open' ? '/admin/jobs' : `/admin/jobs?status=${f.id}`} className={f.id === filter ? 'on' : undefined} aria-current={f.id === filter ? 'true' : undefined}>
          {f.label}
        </a>
      ))}
    </nav>
  );
}

const RETRY_PROBLEMS: Record<string, string> = {
  reason: 'กรอกเหตุผล 10–500 ตัวอักษร',
  forbidden: 'บัญชีนี้ไม่มีสิทธิ์สั่งงานซ้ำ',
  expired: 'หมดเวลาใช้งาน เข้าสู่ระบบใหม่แล้วลองอีกครั้ง',
  busy: 'ระบบกำลังทำคิวนี้อยู่แล้ว รอสักครู่แล้วโหลดหน้าใหม่',
  limit: 'สั่งลองใหม่งานนี้ครบ 3 ครั้งใน 24 ชั่วโมงแล้ว แก้สาเหตุก่อน แล้วรอให้ระบบลองเองหรือลองพรุ่งนี้',
  superseded: 'ผู้ใช้ขอส่งออกข้อมูลใหม่ไปแล้ว ไม่ต้องลองงานนี้อีก',
  gone: 'ไม่พบงานนี้แล้ว',
  rate: RATE_LIMITED,
  down: 'สั่งงานไม่ได้ในขณะนี้ ลองใหม่อีกครั้ง',
};

/** The last retry's outcome, shown above the list so it survives the job leaving the list on refresh. */
const Flash = createContext<(msg: string) => void>(() => undefined);

/**
 * "Retry now" with a required reason. The API refuses a retry within a minute of the last attempt and after
 * 3 staff retries of the same job in 24 hours. On a dead letter it starts a new round of 5 attempts.
 */
function Retry({ job, className = 'btn secondary' }: { job: Job; className?: string }) {
  const { csrfToken } = useAdmin();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const flash = useContext(Flash);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (open) ref.current?.focus();
  }, [open]);
  if (job.status === 'completed') return null;

  async function submit(ev: React.FormEvent) {
    ev.preventDefault();
    setBusy(true);
    setProblem('');
    try {
      const res = await fetch(`/bff/admin/jobs/${job.id}/retry`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ reason }),
      });
      const body = (await res.json().catch(() => ({}))) as { status?: JobStatus; code?: string; details?: { retryAfterSeconds?: number } };
      if (res.ok) {
        flash(
          body.status === 'completed'
            ? DONE_FLASH[job.kind]
            : body.status === 'dead_letter'
              ? `ยังไม่สำเร็จ ลองครบ 5 ครั้งแล้ว ดูสาเหตุในบันทึก ${FAIL_EVENT[job.kind]}`
              : `ยังไม่สำเร็จ ระบบจะลองต่ออัตโนมัติ ดูสาเหตุในบันทึก ${FAIL_EVENT[job.kind]}`,
        );
        setOpen(false);
        setReason('');
        router.refresh();
        return;
      }
      if (body.code === 'JOB_RETRY_TOO_SOON') setProblem(`เพิ่งลองไปเมื่อครู่ รออีก ${body.details?.retryAfterSeconds ?? 60} วินาที`);
      else if (body.code === 'JOB_RETRY_LIMIT') setProblem(RETRY_PROBLEMS.limit);
      else if (body.code === 'JOB_SUPERSEDED') setProblem(RETRY_PROBLEMS.superseded);
      else setProblem(RETRY_PROBLEMS[res.status === 400 ? 'reason' : res.status === 403 ? 'forbidden' : res.status === 401 ? 'expired' : res.status === 409 ? 'busy' : res.status === 404 ? 'gone' : res.status === 429 ? 'rate' : 'down']);
    } catch {
      setProblem(RETRY_PROBLEMS.down);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="jb-retry">
      <button type="button" className={className} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {job.status === 'dead_letter' ? 'เริ่มลองรอบใหม่' : 'ลองใหม่ตอนนี้'}
      </button>
      {open && (
        <form className="au-export-panel" onSubmit={submit} aria-label={`ลองงาน ${shortId(job.id)} ใหม่`}>
          <label className="fld">
            <span>เหตุผล (จะถูกบันทึกไว้ในประวัติ)</span>
            <textarea ref={ref} value={reason} onChange={(e) => setReason(e.target.value)} minLength={10} maxLength={500} rows={3} required />
          </label>
          <small className="dim">
            {job.status === 'dead_letter'
              ? 'งานนี้ลองครบ 5 ครั้งแล้ว ระบบหยุดลองเอง ปุ่มนี้เริ่มรอบใหม่อีก 5 ครั้ง (สั่งได้ 3 ครั้งต่องานใน 24 ชั่วโมง)'
              : 'ระบบลองใหม่เองหลัง 1, 5, 15 และ 60 นาทีอยู่แล้ว ปุ่มนี้แค่ไม่ต้องรอรอบถัดไป (สั่งได้ 3 ครั้งต่องานใน 24 ชั่วโมง)'}
          </small>
          {problem && (
            <p role="alert" className="au-export-err">
              {problem}
            </p>
          )}
          <div className="row">
            <button type="submit" className="btn" disabled={busy}>
              {busy ? 'กำลังลอง…' : 'ลองใหม่'}
            </button>
            <button type="button" className="btn secondary" onClick={() => setOpen(false)}>
              ยกเลิก
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

function Problem({ status }: { status: number }) {
  return (
    <div className="adm-alert" role="alert">
      {status === 403 ? 'บัญชีนี้ไม่มีสิทธิ์ดูงานเบื้องหลัง (ต้องเป็นโอเปอเรเตอร์หรือแอดมิน)' : status === 429 ? RATE_LIMITED : 'โหลดรายการงานไม่ได้ในขณะนี้ ลองใหม่อีกครั้ง'}
    </div>
  );
}

function Empty({ filter }: { filter: JobFilter }) {
  return <p className="jb-empty dim">{filter === 'completed' ? 'ไม่มีงานที่เสร็จใน 7 วันล่าสุด' : 'ไม่มีงานค้าง'}</p>;
}

const Note = ({ page }: { page: JobsPage }) => (
  <p className="ov-foot dim">
    งานที่ไม่สำเร็จจะถูกลองใหม่อัตโนมัติหลัง 1, 5, 15 และ 60 นาที ครบ 5 ครั้งแล้วจะหยุดรอทีมงาน · คำขอลบบัญชีต้องเสร็จใน 30 วันตาม Doc 17 ระหว่างรอบัญชียังถูกล็อก · รหัสข้อผิดพลาดเป็นรหัสสั้นเท่านั้น · รหัสงานไม่ใช่รหัสผู้ใช้
    {page.truncated ? ' · แสดง 100 รายการแรก' : ''}
  </p>
);

export function JobsView(props: { page?: JobsPage; status: number; filter: JobFilter }) {
  const [flash, setFlash] = useState('');
  return (
    <Flash.Provider value={setFlash}>
      {flash && (
        <p className="adm-ok jb-flash" role="status">
          {flash}
        </p>
      )}
      <Layout {...props} />
    </Flash.Provider>
  );
}

function Layout({ page, status, filter }: { page?: JobsPage; status: number; filter: JobFilter }) {
  const { theme } = useAdmin();
  const [sel, setSel] = useState(0);
  if (!page) return <Problem status={status} />;
  const { jobs, counts, queues } = page;

  if (theme === 'control-room') {
    return (
      <div className="cr-page jb">
        <div className="top">
          <div className="crumb">
            Operations<b>งานเบื้องหลัง</b>
          </div>
          <Filters filter={filter} className="seg" />
        </div>
        <div className="ov-kpis jb-kpis">
          <div className="pn">
            <small>รอทำ</small>
            <b className="mo">{counts.pending}</b>
          </div>
          <div className={`pn${counts.retrying ? ' warn' : ''}`}>
            <small>กำลังลองใหม่</small>
            <b className="mo">{counts.retrying}</b>
          </div>
          <div className={`pn${counts.dead_letter ? ' warn' : ''}`}>
            <small>รอทีมงาน (dead letter)</small>
            <b className="mo">{counts.dead_letter}</b>
          </div>
          <div className="pn">
            <small>เสร็จใน 7 วัน</small>
            <b className="mo">{counts.completed}</b>
          </div>
        </div>
        <div className="pn">
          <table className="jb-table jb-queues">
            <thead>
              <tr>
                <th scope="col">คิว</th>
                <th scope="col">รอทำ</th>
                <th scope="col">ลองใหม่</th>
                <th scope="col">รอทีมงาน</th>
                <th scope="col">ค้างนานสุด</th>
              </tr>
            </thead>
            <tbody>
              {queues.map((q) => (
                <tr key={q.kind}>
                  <td>{KIND_LABEL[q.kind]}</td>
                  <td className="mo">{q.pending}</td>
                  <td className="mo">{q.retrying}</td>
                  <td className={`mo${q.deadLetter ? ' jb-late' : ''}`}>{q.deadLetter}</td>
                  <td className="mo">{q.oldestOpenAt ? age(q.oldestOpenAt) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="pn">
          {jobs.length === 0 ? (
            <Empty filter={filter} />
          ) : (
            <table className="jb-table">
              <thead>
                <tr>
                  <th scope="col">งาน</th>
                  <th scope="col">สถานะ</th>
                  <th scope="col">อายุ</th>
                  <th scope="col">ลองแล้ว</th>
                  <th scope="col">ลองล่าสุด</th>
                  <th scope="col">ลองครั้งถัดไป</th>
                  <th scope="col">รหัสข้อผิดพลาด</th>
                  <th scope="col">กำหนด</th>
                  <th scope="col">
                    <span className="sr-only">สั่งงาน</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((j) => (
                  <tr key={j.id}>
                    <td>
                      {KIND_LABEL[j.kind]} <span className="mo dim">{shortId(j.id)}</span>
                    </td>
                    <td>
                      <span className={`tag jb-${j.status}`}>{STATUS_LABEL[j.status]}</span>
                    </td>
                    <td className="mo">{age(j.requestedAt)}</td>
                    <td className="mo">{tries(j)}</td>
                    <td className="mo">{j.lastAttemptAt ? formatLogTime(j.lastAttemptAt) : '—'}</td>
                    <td className={j.status === 'dead_letter' ? 'jb-late' : 'mo'}>{next(j)}</td>
                    <td className="mo">{errCode(j)}</td>
                    <td className={late(j) ? 'jb-late' : undefined}>{due(j)}</td>
                    <td>
                      <Retry job={j} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <Note page={page} />
      </div>
    );
  }

  if (theme === 'broadcast-rack') {
    return (
      <div className="br-page jb">
        <div className="ttl">
          <h3>งานเบื้องหลัง · Queue</h3>
          <span>
            รอทำ {counts.pending} · ลองใหม่ {counts.retrying} · รอทีมงาน {counts.dead_letter} · เสร็จ 7 วัน {counts.completed}
          </span>
        </div>
        <ul className="jb-rack jb-queues">
          {queues.map((q) => (
            <li key={q.kind} className="adm-panel">
              <span className="lamp-row">
                <i className={`lamp ${q.deadLetter ? 'jb-dead_letter' : q.retrying ? 'jb-retrying' : q.pending ? 'jb-pending' : 'jb-completed'}`} aria-hidden="true" />
                <b>{KIND_LABEL[q.kind]}</b>
              </span>
              <span className="mo">{queueLine(q)}</span>
            </li>
          ))}
        </ul>
        <div className="br-pick">
          <Filters filter={filter} className="knobs" />
        </div>
        {jobs.length === 0 ? (
          <Empty filter={filter} />
        ) : (
          <ul className="jb-rack">
            {jobs.map((j) => (
              <li key={j.id} className={`adm-panel jb-${j.status}`}>
                <span className="lamp-row">
                  <i className={`lamp jb-${j.status}`} aria-hidden="true" />
                  <b>{KIND_LABEL[j.kind]}</b> <span className="mo dim">{shortId(j.id)}</span>
                </span>
                <span>{STATUS_LABEL[j.status]}</span>
                <span className="mo">
                  อายุ {age(j.requestedAt)} · ลอง {tries(j)} · ถัดไป {next(j)}
                  {j.lastErrorCode ? ` · ${j.lastErrorCode}` : ''}
                </span>
                <span className={late(j) ? 'jb-late' : 'dim'}>{due(j)}</span>
                <Retry job={j} />
              </li>
            ))}
          </ul>
        )}
        <Note page={page} />
      </div>
    );
  }

  if (theme === 'daylight-bento') {
    return (
      <div className="db-page jb">
        <div className="hello">
          <div>
            <h3>งานเบื้องหลัง</h3>
            <p>คิวที่ระบบทำต่อเอง พร้อมอายุ จำนวนครั้งที่ลอง และรหัสข้อผิดพลาด · เสร็จใน 7 วัน {counts.completed}</p>
          </div>
        </div>
        <div className="search">
          <Filters filter={filter} className="chips" />
        </div>
        <div className="jb-bento">
          {(['pending', 'retrying', 'dead_letter'] as const).map((s) => (
            <section key={s} className={`b-kpi${s !== 'pending' && counts[s] ? ' warn' : ''}`}>
              <small>{s === 'dead_letter' ? 'รอทีมงาน (dead letter)' : s === 'retrying' ? 'กำลังลองใหม่' : 'รอทำ'}</small>
              <b>{counts[s]}</b>
            </section>
          ))}
          {queues.map((q) => (
            <section key={q.kind} className="b-queue">
              <h4>{KIND_LABEL[q.kind]}</h4>
              <small className={q.deadLetter ? 'jb-late' : undefined}>{queueLine(q)}</small>
            </section>
          ))}
          {jobs.length === 0 ? (
            <section className="b-wide">
              <Empty filter={filter} />
            </section>
          ) : (
            jobs.map((j) => (
              <section key={j.id} className="b-job">
                <h4>
                  {KIND_LABEL[j.kind]} <span className="dim">{shortId(j.id)}</span>
                </h4>
                <span className={`hl-pill jb-${j.status}`}>{STATUS_LABEL[j.status]}</span>
                <small>
                  อายุ {age(j.requestedAt)} · ลอง {tries(j)}{j.lastAttemptAt ? ` · ล่าสุด ${formatLogTime(j.lastAttemptAt)}` : ''}
                </small>
                <small>
                  ถัดไป {next(j)}
                  {j.lastErrorCode ? ` · รหัส ${j.lastErrorCode}` : ''}
                </small>
                <small className={late(j) ? 'jb-late' : undefined}>{due(j)}</small>
                <Retry job={j} />
              </section>
            ))
          )}
        </div>
        <Note page={page} />
      </div>
    );
  }

  if (theme === 'workbench') {
    const cur = jobs[Math.min(sel, jobs.length - 1)];
    return (
      <div className="split">
        <section className="list" aria-label="รายการงาน">
          <div className="lh">
            <h3>
              งานเบื้องหลัง <span>{jobs.length}</span>
            </h3>
            <Filters filter={filter} className="wb-seg" />
          </div>
          <div className="lh jb-queues">
            {queues.map((q) => (
              <small key={q.kind} className={q.deadLetter ? 'jb-late' : 'dim'}>
                {KIND_LABEL[q.kind]}: {queueLine(q)}
              </small>
            ))}
          </div>
          {jobs.length === 0 ? (
            <div className="lh">
              <Empty filter={filter} />
            </div>
          ) : (
            <ul>
              {jobs.map((j, i) => (
                <li key={j.id} className={`it jb-it${j === cur ? ' sel' : ''}`}>
                  <i className={`ic jb-${j.status}`} aria-hidden="true" />
                  <button type="button" className="lg-pick" onClick={() => setSel(i)} aria-pressed={j === cur}>
                    <b>
                      {KIND_LABEL[j.kind]} {shortId(j.id)}
                    </b>
                  </button>
                  <span className="r">{age(j.requestedAt)}</span>
                  <small>{STATUS_LABEL[j.status]}</small>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="det" aria-label="รายละเอียดงาน">
          {cur ? (
            <div className="lg-detail">
              <p className="crumb">งานเบื้องหลัง / {KIND_LABEL[cur.kind]}</p>
              <h2 className="mo">{shortId(cur.id)}</h2>
              <dl className="ov-dl jb-dl">
                <div>
                  <dt>สถานะ</dt>
                  <dd>{STATUS_LABEL[cur.status]}</dd>
                </div>
                <div>
                  <dt>ขอเมื่อ</dt>
                  <dd className="mo">{formatLogTime(cur.requestedAt)}</dd>
                </div>
                <div>
                  <dt>ลองแล้ว</dt>
                  <dd className="mo">{tries(cur)} ครั้ง</dd>
                </div>
                <div>
                  <dt>ลองล่าสุด</dt>
                  <dd className="mo">{cur.lastAttemptAt ? formatLogTime(cur.lastAttemptAt) : '—'}</dd>
                </div>
                <div>
                  <dt>ลองครั้งถัดไป</dt>
                  <dd className={cur.status === 'dead_letter' ? 'jb-late' : 'mo'}>{next(cur)}</dd>
                </div>
                <div>
                  <dt>รหัสข้อผิดพลาด</dt>
                  <dd className="mo">{errCode(cur)}</dd>
                </div>
                <div>
                  <dt>กำหนด</dt>
                  <dd className={late(cur) ? 'jb-late' : undefined}>{due(cur)}</dd>
                </div>
              </dl>
              <Retry job={cur} />
              <Note page={page} />
            </div>
          ) : (
            <div className="lg-detail">
              <Note page={page} />
            </div>
          )}
        </section>
      </div>
    );
  }

  // Minimal (FinVault cards)
  const oldest = jobs.filter((j) => j.status !== 'completed').reduce<Job | null>((a, j) => (!a || j.requestedAt < a.requestedAt ? j : a), null);
  return (
    <div className="fv-dash jb">
      <div className="fv-logstats">
        <section className="fv-card">
          <small className="fv-label">รอทำ</small>
          <p className="fv-amount">{counts.pending}</p>
          <small>ระบบกำลังทำ</small>
        </section>
        <section className="fv-card">
          <small className="fv-label">กำลังลองใหม่</small>
          <p className={`fv-amount${counts.retrying ? ' hot' : ''}`}>{counts.retrying}</p>
          <small>ลองเองหลัง 1, 5, 15, 60 นาที</small>
        </section>
        <section className="fv-card">
          <small className="fv-label">รอทีมงาน</small>
          <p className={`fv-amount${counts.dead_letter ? ' hot' : ''}`}>{counts.dead_letter}</p>
          <small>ลองครบ 5 ครั้งแล้ว · เสร็จใน 7 วัน {counts.completed}</small>
        </section>
        <section className="fv-card">
          <small className="fv-label">ค้างนานสุด</small>
          <p className="fv-amount">{oldest ? age(oldest.requestedAt) : '—'}</p>
          <small>{oldest ? due(oldest) : 'ไม่มีงานค้าง'}</small>
        </section>
      </div>
      <section className="fv-card" aria-labelledby="fv-jobs">
        <div className="fv-card-head">
          <div>
            <h2 id="fv-jobs">งานเบื้องหลัง</h2>
            <small>{queues.map((q) => `${KIND_LABEL[q.kind]} ${q.pending + q.retrying + q.deadLetter}`).join(' · ')}</small>
          </div>
          <Filters filter={filter} className="fv-seg" />
        </div>
        {jobs.length === 0 ? (
          <Empty filter={filter} />
        ) : (
          <ul className="ov-list jb-list">
            {jobs.map((j) => (
              <li key={j.id}>
                <span className={`ov-sev ${failing(j.status) ? 'critical' : j.status === 'completed' ? 'ok' : 'warning'}`} aria-hidden="true">
                  {failing(j.status) ? '!' : j.status === 'completed' ? '✓' : '•'}
                </span>
                <span className="ov-inc">
                  <b>
                    {KIND_LABEL[j.kind]} <span className="mo dim">{shortId(j.id)}</span>
                  </b>
                  <small>
                    {STATUS_LABEL[j.status]} · อายุ {age(j.requestedAt)} · ลอง {tries(j)} · ถัดไป {next(j)}
                    {j.lastErrorCode ? ` · ${j.lastErrorCode}` : ''} · <span className={late(j) ? 'jb-late' : undefined}>{due(j)}</span>
                  </small>
                </span>
                <Retry job={j} className="fv-outline jb-btn" />
              </li>
            ))}
          </ul>
        )}
      </section>
      <Note page={page} />
    </div>
  );
}
