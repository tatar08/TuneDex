'use client';

import { useRouter } from 'next/navigation';
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { formatLogTime, RATE_LIMITED } from '@/lib/admin';
import type { Job, JobFilter, JobsPage, JobStatus } from '@/lib/bff';
import { useAdmin } from '../AdminShell';

/**
 * Background jobs (Doc 17 /admin/jobs): what is queued, how old it is, how many attempts it took, and an
 * authorized retry with a recorded reason. Today the only queue is account deletion. A failed deletion keeps
 * retrying in the background every 10 minutes; "retry now" only saves waiting for the next run.
 * Data is shared; each theme lays the page out its own way (Tar, 2026-10-03).
 */
const FILTERS: { id: JobFilter; label: string }[] = [
  { id: 'open', label: 'ค้างอยู่' },
  { id: 'failed', label: 'ไม่สำเร็จ' },
  { id: 'completed', label: 'เสร็จแล้ว (7 วัน)' },
  { id: 'all', label: 'ทั้งหมด' },
];
const STATUS_LABEL: Record<JobStatus, string> = { pending: 'รอทำ', failed: 'ไม่สำเร็จ กำลังลองใหม่อัตโนมัติ', completed: 'เสร็จแล้ว' };
const KIND_LABEL: Record<Job['kind'], string> = { account_deletion: 'ลบบัญชีผู้ใช้' };

function age(iso: string, now = Date.now()) {
  const m = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60_000));
  if (m < 60) return `${m} นาที`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} ชั่วโมง` : `${Math.round(h / 24)} วัน`;
}
function due(job: Job, now = Date.now()) {
  if (job.status === 'completed') return job.completedAt ? `เสร็จ ${formatLogTime(job.completedAt)}` : 'เสร็จแล้ว';
  const d = Math.ceil((new Date(job.deadline).getTime() - now) / 86_400_000);
  return d > 0 ? `ต้องเสร็จใน ${d} วัน` : 'เลยกำหนด 30 วันแล้ว';
}
const late = (job: Job) => job.status !== 'completed' && new Date(job.deadline).getTime() - Date.now() < 5 * 86_400_000;
const shortId = (id: string) => id.slice(0, 8);

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
  gone: 'ไม่พบงานนี้แล้ว',
  rate: RATE_LIMITED,
  down: 'สั่งงานไม่ได้ในขณะนี้ ลองใหม่อีกครั้ง',
};

/** The last retry's outcome, shown above the list so it survives the job leaving the list on refresh. */
const Flash = createContext<(msg: string) => void>(() => undefined);

/** "Retry now" with a required reason. The API refuses a retry within a minute of the last attempt. */
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
        flash(body.status === 'completed' ? 'ลบข้อมูลบัญชีเสร็จแล้ว' : 'ยังไม่สำเร็จ ระบบจะลองต่ออัตโนมัติ ดูสาเหตุในบันทึก ACCOUNT_PURGE_FAILED');
        setOpen(false);
        setReason('');
        router.refresh();
        return;
      }
      if (body.code === 'JOB_RETRY_TOO_SOON') setProblem(`เพิ่งลองไปเมื่อครู่ รออีก ${body.details?.retryAfterSeconds ?? 60} วินาที`);
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
        ลองใหม่ตอนนี้
      </button>
      {open && (
        <form className="au-export-panel" onSubmit={submit} aria-label={`ลองงาน ${shortId(job.id)} ใหม่`}>
          <label className="fld">
            <span>เหตุผล (จะถูกบันทึกไว้ในประวัติ)</span>
            <textarea ref={ref} value={reason} onChange={(e) => setReason(e.target.value)} minLength={10} maxLength={500} rows={3} required />
          </label>
          <small className="dim">ระบบลองใหม่เองทุก 10 นาทีอยู่แล้ว ปุ่มนี้แค่ไม่ต้องรอรอบถัดไป</small>
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
    งานที่ไม่สำเร็จจะถูกลองใหม่อัตโนมัติทุก 10 นาทีจนกว่าจะเสร็จ (ต้องเสร็จใน 30 วันตาม Doc 17) · รหัสงานไม่ใช่รหัสผู้ใช้{page.truncated ? ' · แสดง 100 รายการแรก' : ''}
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
  const { jobs, counts } = page;

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
          <div className={`pn${counts.failed ? ' warn' : ''}`}>
            <small>ไม่สำเร็จ</small>
            <b className="mo">{counts.failed}</b>
          </div>
          <div className="pn">
            <small>เสร็จใน 7 วัน</small>
            <b className="mo">{counts.completed}</b>
          </div>
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
                    <td className="mo">{j.attempts}</td>
                    <td className="mo">{j.lastAttemptAt ? formatLogTime(j.lastAttemptAt) : '—'}</td>
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
            รอทำ {counts.pending} · ไม่สำเร็จ {counts.failed} · เสร็จ 7 วัน {counts.completed}
          </span>
        </div>
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
                  อายุ {age(j.requestedAt)} · ลอง {j.attempts} ครั้ง
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
            <p>คิวที่ระบบทำต่อเอง พร้อมอายุและจำนวนครั้งที่ลอง</p>
          </div>
        </div>
        <div className="search">
          <Filters filter={filter} className="chips" />
        </div>
        <div className="jb-bento">
          {(['pending', 'failed', 'completed'] as const).map((s) => (
            <section key={s} className={`b-kpi${s === 'failed' && counts.failed ? ' warn' : ''}`}>
              <small>{s === 'completed' ? 'เสร็จใน 7 วัน' : s === 'failed' ? 'ไม่สำเร็จ' : 'รอทำ'}</small>
              <b>{counts[s]}</b>
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
                  อายุ {age(j.requestedAt)} · ลอง {j.attempts} ครั้ง{j.lastAttemptAt ? ` · ล่าสุด ${formatLogTime(j.lastAttemptAt)}` : ''}
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
                  <dd className="mo">{cur.attempts} ครั้ง</dd>
                </div>
                <div>
                  <dt>ลองล่าสุด</dt>
                  <dd className="mo">{cur.lastAttemptAt ? formatLogTime(cur.lastAttemptAt) : '—'}</dd>
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
          <small className="fv-label">ไม่สำเร็จ</small>
          <p className={`fv-amount${counts.failed ? ' hot' : ''}`}>{counts.failed}</p>
          <small>ลองใหม่อัตโนมัติทุก 10 นาที</small>
        </section>
        <section className="fv-card">
          <small className="fv-label">เสร็จใน 7 วัน</small>
          <p className="fv-amount">{counts.completed}</p>
          <small>ลบบัญชีเสร็จ</small>
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
            <small>คิวลบบัญชีผู้ใช้</small>
          </div>
          <Filters filter={filter} className="fv-seg" />
        </div>
        {jobs.length === 0 ? (
          <Empty filter={filter} />
        ) : (
          <ul className="ov-list jb-list">
            {jobs.map((j) => (
              <li key={j.id}>
                <span className={`ov-sev ${j.status === 'failed' ? 'critical' : j.status === 'completed' ? 'ok' : 'warning'}`} aria-hidden="true">
                  {j.status === 'failed' ? '!' : j.status === 'completed' ? '✓' : '•'}
                </span>
                <span className="ov-inc">
                  <b>
                    {KIND_LABEL[j.kind]} <span className="mo dim">{shortId(j.id)}</span>
                  </b>
                  <small>
                    {STATUS_LABEL[j.status]} · อายุ {age(j.requestedAt)} · ลอง {j.attempts} ครั้ง · <span className={late(j) ? 'jb-late' : undefined}>{due(j)}</span>
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
