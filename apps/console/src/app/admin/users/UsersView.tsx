'use client';

import { useState } from 'react';
import { canSeeUsers, formatLogTime, RATE_LIMITED } from '@/lib/admin';
import type { SupportReports, UserSupportView } from '@/lib/bff';
import type { Translate } from '@/lib/admin-i18n';
import { useAdmin, useT } from '../AdminShell';

/**
 * Support lookup (Doc 17 /admin/users): find one customer account by email, user id or device id, and see
 * what support needs to help (email, account state, devices and whether they picked up the latest settings,
 * diagnostics count, deletion state). No setting values, stations or roles.
 * Every lookup needs a reason and is recorded. Data is shared; each theme has its own layout.
 */
type User = UserSupportView;
type Device = User['devices'][number];

const STATUS: Record<User['user']['status'], { label: string; tone: 'ok' | 'warn' | 'bad' | 'mute' }> = {
  active: { label: 'ใช้งานอยู่', tone: 'ok' },
  deleting: { label: 'กำลังลบบัญชี', tone: 'warn' },
  deleted: { label: 'ลบบัญชีแล้ว', tone: 'mute' },
  disabled: { label: 'ระงับการใช้งาน', tone: 'bad' },
};
const DELETION: Record<NonNullable<User['deletion']>['status'], string> = {
  pending: 'กำลังลบ',
  failed: 'ลบไม่สำเร็จ กำลังลองใหม่',
  dead_letter: 'ลบไม่สำเร็จ ลองครบ 5 ครั้ง รอทีมงานสั่งลองใหม่ (บัญชียังถูกล็อก)',
  completed: 'ลบเสร็จแล้ว',
};

const deviceState = (d: Device, revision: number, t: Translate) =>
  d.revokedAt
    ? { label: t('ออกจากระบบแล้ว'), tone: 'mute' as const }
    : d.inSync
      ? { label: t('ได้รับการตั้งค่าล่าสุดแล้ว'), tone: 'ok' as const }
      : { label: t('ยังไม่ได้รับการตั้งค่าล่าสุด (ใช้ r{0} จาก r{1})', d.appliedSettingsRevision, revision), tone: 'warn' as const };
const osLabel = (d: Device) => (d.platform === 'ios' ? `iPhone${d.osMajor ? ` · iOS ${d.osMajor}` : ''}` : `Android${d.osMajor ? ` ${d.osMajor}` : ''}`);
const short = (id: string) => id.slice(0, 8);

const PROBLEMS: Record<string, string> = {
  query: 'ใส่อีเมล หรือรหัสผู้ใช้/รหัสเครื่องให้ครบ (รูปแบบ xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)',
  reason: 'กรอกเหตุผล 10–500 ตัวอักษร',
  notFound: 'ไม่พบบัญชีที่ตรงกัน (หรืออีเมลนี้มีมากกว่าหนึ่งบัญชี ให้ค้นด้วยรหัสแทน) การค้นครั้งนี้ถูกบันทึกแล้ว',
  forbidden: 'บัญชีนี้ไม่มีสิทธิ์ดูข้อมูลผู้ใช้ (ต้องเป็นซัพพอร์ตหรือแอดมิน)',
  expired: 'หมดเวลาใช้งาน เข้าสู่ระบบใหม่แล้วลองอีกครั้ง',
  rate: RATE_LIMITED,
  down: 'ค้นหาไม่ได้ในขณะนี้ ลองใหม่อีกครั้ง',
};

function useLookup() {
  const { csrfToken } = useAdmin();
  const [result, setResult] = useState<User | null>(null);
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);
  async function lookup(query: string, reason: string) {
    setBusy(true);
    setProblem('');
    try {
      const res = await fetch('/bff/admin/users/lookup', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ query, reason }),
      });
      if (res.ok) {
        setResult((await res.json()) as User);
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { details?: { field?: string } };
      setResult(null);
      setProblem(
        PROBLEMS[
          res.status === 400 ? (body.details?.field === 'query' ? 'query' : 'reason') : res.status === 404 ? 'notFound' : res.status === 403 ? 'forbidden' : res.status === 401 ? 'expired' : res.status === 429 ? 'rate' : 'down'
        ],
      );
    } catch {
      setProblem(PROBLEMS.down);
    } finally {
      setBusy(false);
    }
  }
  return { result, problem, busy, lookup };
}

function SearchForm({ busy, problem, onSearch, className = 'us-form' }: { busy: boolean; problem: string; onSearch: (q: string, r: string) => void; className?: string }) {
  const t = useT();
  const [query, setQuery] = useState('');
  const [reason, setReason] = useState('');
  return (
    <form
      className={className}
      aria-label={t('ค้นหาผู้ใช้')}
      onSubmit={(e) => {
        e.preventDefault();
        onSearch(query, reason);
      }}
    >
      <label className="fld">
        <span>{t('อีเมล รหัสผู้ใช้ หรือรหัสเครื่อง')}</span>
        <input id="us-query" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('name@example.com หรือ xxxxxxxx-xxxx-…')} autoComplete="off" spellCheck={false} required />
      </label>
      <label className="fld">
        <span>{t('เหตุผล (จะถูกบันทึกไว้ในประวัติ)')}</span>
        <input id="us-reason" value={reason} onChange={(e) => setReason(e.target.value)} minLength={10} maxLength={500} placeholder={t('เช่น ลูกค้าแจ้งว่าตั้งค่าไม่ซิงก์ เคส #1042')} required />
      </label>
      <button type="submit" className="btn" disabled={busy}>
        {busy ? t('กำลังค้น…') : t('ค้นหา')}
      </button>
      {problem && (
        <p role="alert" className="au-export-err us-problem">
          {t(problem)}
        </p>
      )}
    </form>
  );
}

function Note() {
  const t = useT();
  return <p className="ov-foot dim">{t('ข้อมูลเท่าที่ซัพพอร์ตต้องใช้ ไม่มีค่าที่ตั้งหรือสถานีของผู้ใช้ · ทุกการค้นถูกบันทึกในประวัติพร้อมเหตุผล (ไม่บันทึกอีเมลที่ค้น)')}</p>;
}
function Empty() {
  const t = useT();
  return <p className="dim us-empty">{t('ใส่อีเมล รหัสผู้ใช้ หรือรหัสเครื่องที่ลูกค้าแจ้ง พร้อมเหตุผล แล้วกดค้นหา')}</p>;
}

function Facts({ u }: { u: User }) {
  const t = useT();
  return (
    <dl className="us-facts">
      <div>
        <dt>{t('อีเมล')}</dt>
        <dd>{u.user.email ? (u.user.emailVerified ? u.user.email : t('{0} (ยังไม่ยืนยัน)', u.user.email)) : t('ไม่มี')}</dd>
      </div>
      <div>
        <dt>{t('รหัสผู้ใช้')}</dt>
        <dd className="mo">{u.user.id}</dd>
      </div>
      <div>
        <dt>{t('สมัครเมื่อ')}</dt>
        <dd>{formatLogTime(u.user.createdAt, t.lang)}</dd>
      </div>
      <div>
        <dt>{t('การตั้งค่า')}</dt>
        <dd>{u.settings.revision ? t('r{0} · บันทึก {1}', u.settings.revision, formatLogTime(u.settings.updatedAt!, t.lang)) : t('ยังไม่เคยบันทึก')}</dd>
      </div>
      <div>
        <dt>{t('รายงานวินิจฉัย 7 วัน')}</dt>
        <dd>{t('{0} ฉบับ', u.diagnostics.reportsLast7Days)}</dd>
      </div>
      <div>
        <dt>{t('การลบบัญชี')}</dt>
        <dd>{u.deletion ? t('{0} · ขอเมื่อ {1}', t(DELETION[u.deletion.status]), formatLogTime(u.deletion.requestedAt, t.lang)) : t('ไม่มีคำขอ')}</dd>
      </div>
    </dl>
  );
}

function DeviceTable({ u }: { u: User }) {
  const t = useT();
  if (u.devices.length === 0) return <p className="dim">{t('ยังไม่มีเครื่องลงทะเบียน')}</p>;
  return (
    <div className="us-scroll">
      <table className="us-table">
        <caption className="sr-only">{t('เครื่องของผู้ใช้')}</caption>
        <thead>
          <tr>
            <th scope="col">{t('เครื่อง')}</th>
            <th scope="col">{t('แอป')}</th>
            <th scope="col">{t('ติดต่อล่าสุด')}</th>
            <th scope="col">{t('สถานะ')}</th>
          </tr>
        </thead>
        <tbody>
          {u.devices.map((d) => {
            const s = deviceState(d, u.settings.revision, t);
            return (
              <tr key={d.id}>
                <td>
                  {osLabel(d)} <span className="mo dim">{short(d.id)}</span>
                </td>
                <td className="mo">{d.appBuild}</td>
                <td>{formatLogTime(d.lastSeenAt, t.lang)}</td>
                <td>
                  <span className={`us-tone ${s.tone}`}>{s.label}</span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const DIAG_PROBLEMS: Record<string, string> = {
  code: 'รหัสต้องมี 8 ตัว เช่น ABCD-EFGH',
  reason: 'กรอกเหตุผล 10–500 ตัวอักษร',
  notFound: 'รหัสนี้ใช้ไม่ได้ (ผิด ใช้ไปแล้ว หมดอายุ หรือเป็นของบัญชีอื่น) ให้ลูกค้าสร้างรหัสใหม่ การลองครั้งนี้ถูกบันทึกแล้ว',
  noAccess: 'สิทธิ์ดูรายงานหมดแล้ว หรือลูกค้ายกเลิกแล้ว ขอรหัสใหม่จากลูกค้า',
  expired: PROBLEMS.expired,
  rate: RATE_LIMITED,
  down: 'ทำรายการไม่ได้ในขณะนี้ ลองใหม่อีกครั้ง',
};

/**
 * Doc 17 "support: redacted case diagnostics that were granted". The customer makes a one-time code on /app/privacy
 * (or in the app) and reads it out; entering it here with a reason lets this support member, and only them, read
 * the customer's reports for 7 days. Each read is recorded. Shared by every theme; each places it in its own layout.
 */
function SupportDiagnostics({ u }: { u: User }) {
  const { csrfToken } = useAdmin();
  const t = useT();
  const [access, setAccess] = useState(u.diagnostics.access);
  const [data, setData] = useState<SupportReports | null>(null);
  const [code, setCode] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const problemOf = (status: number, field?: string) =>
    DIAG_PROBLEMS[
      status === 400 ? (field === 'code' ? 'code' : 'reason') : status === 404 ? 'notFound' : status === 403 ? 'noAccess' : status === 401 ? 'expired' : status === 429 ? 'rate' : 'down'
    ];

  async function load() {
    setBusy(true);
    setProblem('');
    try {
      const res = await fetch(`/bff/admin/users/${u.user.id}/diagnostics`);
      if (res.ok) setData((await res.json()) as SupportReports);
      else {
        if (res.status === 403) setAccess(null);
        setProblem(problemOf(res.status));
      }
    } catch {
      setProblem(DIAG_PROBLEMS.down);
    } finally {
      setBusy(false);
    }
  }

  async function redeem() {
    setBusy(true);
    setProblem('');
    try {
      const res = await fetch(`/bff/admin/users/${u.user.id}/diagnostics/access`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ code, reason }),
      });
      if (res.status === 201) {
        const grant = (await res.json()) as { id: string; expiresAt: string };
        setAccess({ id: grant.id, expiresAt: grant.expiresAt });
        setCode('');
        setBusy(false);
        await load();
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { details?: { field?: string } };
      setProblem(problemOf(res.status, body.details?.field));
    } catch {
      setProblem(DIAG_PROBLEMS.down);
    }
    setBusy(false);
  }

  return (
    <div className="us-diag">
      {problem && (
        <p role="alert" className="au-export-err us-problem">
          {t(problem)}
        </p>
      )}
      {!access ? (
        <form
          className="us-form"
          aria-label={t('ขอดูรายงานวินิจฉัย')}
          onSubmit={(e) => {
            e.preventDefault();
            void redeem();
          }}
        >
          <p className="dim">{t('ให้ลูกค้ากด “สร้างรหัสให้ทีม support” ในหน้าความเป็นส่วนตัว แล้วอ่านรหัสให้ฟัง รหัสใช้ได้ครั้งเดียวภายใน 1 ชั่วโมง')}</p>
          <label className="fld">
            <span>{t('รหัสจากลูกค้า')}</span>
            <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="ABCD-EFGH" autoComplete="off" spellCheck={false} maxLength={12} required />
          </label>
          <label className="fld">
            <span>{t('เหตุผลที่ขอดูรายงาน (จะถูกบันทึกไว้ในประวัติ)')}</span>
            <input value={reason} onChange={(e) => setReason(e.target.value)} minLength={10} maxLength={500} placeholder={t('เช่น ลูกค้าแจ้งว่าเล่นวิทยุไม่ได้ เคส #1042')} required />
          </label>
          <button type="submit" className="btn" disabled={busy}>
            {busy ? t('กำลังตรวจรหัส…') : t('ขอดูรายงาน')}
          </button>
        </form>
      ) : !data ? (
        <p>
          <span className="dim">{t('ลูกค้าให้สิทธิ์คุณดูรายงานได้ถึง {0} · การเปิดดูถูกบันทึก', formatLogTime(access.expiresAt, t.lang))} </span>
          <button type="button" className="btn" disabled={busy} onClick={() => void load()}>
            {busy ? t('กำลังโหลด…') : t('เปิดดูรายงาน')}
          </button>
        </p>
      ) : (
        <>
          <p className="dim">
            {t('ดูได้ถึง {0} · รายงานถูกลบเองเมื่อครบ {1} วัน · มีแค่รหัสผลลัพธ์ ไม่มีชื่อช่อง ลิงก์ หรือตำแหน่ง', formatLogTime(data.access.expiresAt, t.lang), data.retentionDays)}
          </p>
          {data.reports.length === 0 ? (
            <p className="dim">{t('ไม่มีรายงานใน {0} วันที่ผ่านมา', data.retentionDays)}</p>
          ) : (
            data.reports.map((r) => (
              <div key={r.id} className="us-scroll" data-testid="support-report">
                <table className="us-table">
                  <caption>
                    {formatLogTime(r.receivedAt, t.lang)} · {r.platform === 'ios' ? 'iPhone' : r.platform === 'android' ? 'Android' : t('เครื่องที่ออกจากระบบแล้ว')} · {t('{0} เหตุการณ์', r.eventCount)}
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">{t('เวลา (วินาที)')}</th>
                      <th scope="col">{t('เหตุการณ์')}</th>
                      <th scope="col">{t('ผลลัพธ์')}</th>
                      <th scope="col">{t('ใช้เวลา')}</th>
                      <th scope="col">{t('เครือข่าย')}</th>
                      <th scope="col">{t('แอป')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.items.map((e, i) => (
                      <tr key={i}>
                        <td className="mo">{(e.monotonicMs / 1000).toFixed(1)}</td>
                        <td className="mo">{e.eventName}</td>
                        <td className="mo">{e.resultCode ?? '–'}</td>
                        <td className="mo">{e.durationMs === null ? '–' : `${e.durationMs} ms`}</td>
                        <td>{e.networkClass}</td>
                        <td className="mo">{e.appBuild}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))
          )}
        </>
      )}
    </div>
  );
}

function StatusBadge({ u, className = 'us-tone' }: { u: User; className?: string }) {
  const t = useT();
  return <span className={`${className} ${STATUS[u.user.status].tone}`}>{t(STATUS[u.user.status].label)}</span>;
}
const matchedLine = (u: User, t: Translate) => t(u.matchedBy === 'device' ? 'พบจากรหัสเครื่อง' : u.matchedBy === 'email' ? 'พบจากอีเมล' : 'พบจากรหัสผู้ใช้');
const activeDevices = (u: User) => u.devices.filter((d) => !d.revokedAt);
const outOfSync = (u: User) => activeDevices(u).filter((d) => !d.inSync).length;

export function UsersView() {
  const { theme, roles } = useAdmin();
  const t = useT();
  const { result: u, problem, busy, lookup } = useLookup();
  const [sel, setSel] = useState('account');
  if (!canSeeUsers(roles)) {
    return (
      <div className="adm-alert" role="alert">
        {t(PROBLEMS.forbidden)}
      </div>
    );
  }
  const form = <SearchForm busy={busy} problem={problem} onSearch={lookup} />;

  if (theme === 'control-room') {
    return (
      <div className="cr-page us">
        <div className="top">
          <div className="crumb">
            Support<b>{t('ผู้ใช้')}</b>
          </div>
        </div>
        <div className="pn us-search">{form}</div>
        {u ? (
          <>
            <div className="ov-kpis us-kpis">
              <div className="pn">
                <small>{t('บัญชี')}</small>
                <b>
                  <StatusBadge u={u} />
                </b>
                <span className="dim">{matchedLine(u, t)}</span>
              </div>
              <div className="pn">
                <small>{t('เครื่องที่ใช้อยู่')}</small>
                <b className="mo">{activeDevices(u).length}</b>
                <span className="dim">{t('ทั้งหมด {0}', u.devices.length)}</span>
              </div>
              <div className={`pn${outOfSync(u) ? ' warn' : ''}`}>
                <small>{t('ยังไม่ได้รับการตั้งค่าล่าสุด')}</small>
                <b className="mo">{outOfSync(u)}</b>
                <span className="dim">{t('การตั้งค่า r{0}', u.settings.revision)}</span>
              </div>
            </div>
            <div className="ov-grid">
              <div className="pn">
                <h3>Devices</h3>
                <DeviceTable u={u} />
              </div>
              <div className="pn">
                <h3>Account</h3>
                <Facts u={u} />
              </div>
            </div>
            <div className="pn">
              <h3>Diagnostics</h3>
              <SupportDiagnostics key={u.user.id} u={u} />
            </div>
          </>
        ) : (
          <Empty />
        )}
        <Note />
      </div>
    );
  }

  if (theme === 'broadcast-rack') {
    return (
      <div className="br-page us">
        <div className="ttl">
          <h3>{t('ผู้ใช้ · Support Desk')}</h3>
          <span>{t('ค้นได้ทีละบัญชี พร้อมเหตุผล')}</span>
        </div>
        <div className="adm-panel">{form}</div>
        {u ? (
          <>
            <div className="ov-lamps">
              <span className="lamp-row">
                <i className={`lamp us-${STATUS[u.user.status].tone}`} aria-hidden="true" /> {t('บัญชี: {0} · {1}', t(STATUS[u.user.status].label), matchedLine(u, t))}
              </span>
              <span className="lamp-row">
                <i className={`lamp us-${outOfSync(u) ? 'warn' : 'ok'}`} aria-hidden="true" /> {t('เครื่องที่ยังไม่ได้รับการตั้งค่าล่าสุด {0} จาก {1}', outOfSync(u), activeDevices(u).length)}
              </span>
            </div>
            <ul className="us-rack">
              {u.devices.map((d) => {
                const s = deviceState(d, u.settings.revision, t);
                return (
                  <li key={d.id} className="adm-panel">
                    <span className="lamp-row">
                      <i className={`lamp us-${s.tone}`} aria-hidden="true" />
                      <b>{osLabel(d)}</b> <span className="mo dim">{short(d.id)}</span>
                    </span>
                    <span className="mo">{d.appBuild}</span>
                    <span>{t('ล่าสุด {0}', formatLogTime(d.lastSeenAt, t.lang))}</span>
                    <span>{s.label}</span>
                  </li>
                );
              })}
            </ul>
            <div className="adm-panel">
              <Facts u={u} />
            </div>
            <div className="adm-panel">
              <div className="ttl">
                <h3>{t('รายงานวินิจฉัย')}</h3>
              </div>
              <SupportDiagnostics key={u.user.id} u={u} />
            </div>
          </>
        ) : (
          <Empty />
        )}
        <Note />
      </div>
    );
  }

  if (theme === 'daylight-bento') {
    return (
      <div className="db-page us">
        <div className="hello">
          <div>
            <h3>{t('ผู้ใช้')}</h3>
            <p>{t('ช่วยลูกค้าจากรหัสที่เขาแจ้ง ดูได้ทีละบัญชี')}</p>
          </div>
        </div>
        <div className="us-bento">
          <section className="b-search">{form}</section>
          {u ? (
            <>
              <section className="b-kpi">
                <small>{t('บัญชี')}</small>
                <StatusBadge u={u} className="hl-pill us-tone" />
                <span>{matchedLine(u, t)}</span>
              </section>
              <section className={`b-kpi${outOfSync(u) ? ' warn' : ''}`}>
                <small>{t('ยังไม่ได้รับการตั้งค่าล่าสุด')}</small>
                <b>{outOfSync(u)}</b>
                <span>{t('จาก {0} เครื่องที่ใช้อยู่', activeDevices(u).length)}</span>
              </section>
              {u.devices.map((d) => {
                const s = deviceState(d, u.settings.revision, t);
                return (
                  <section key={d.id} className="b-device">
                    <h4>
                      {osLabel(d)} <span className="dim">{short(d.id)}</span>
                    </h4>
                    <span className={`hl-pill us-tone ${s.tone}`}>{s.label}</span>
                    <small>
                      {t('แอป {0} · ล่าสุด {1}', d.appBuild, formatLogTime(d.lastSeenAt, t.lang))}
                    </small>
                  </section>
                );
              })}
              <section className="b-facts">
                <h4>{t('บัญชี')}</h4>
                <Facts u={u} />
              </section>
              <section className="b-facts">
                <h4>{t('รายงานวินิจฉัย')}</h4>
                <SupportDiagnostics key={u.user.id} u={u} />
              </section>
            </>
          ) : (
            <section className="b-facts">
              <Empty />
            </section>
          )}
        </div>
        <Note />
      </div>
    );
  }

  if (theme === 'workbench') {
    const items = u
      ? [
          { id: 'account', title: t('บัญชี'), sub: t(STATUS[u.user.status].label), tone: STATUS[u.user.status].tone as string },
          {
            id: 'diagnostics',
            title: t('รายงานวินิจฉัย'),
            sub: u.diagnostics.access ? t('ดูได้ถึง {0}', formatLogTime(u.diagnostics.access.expiresAt, t.lang)) : t('{0} ฉบับ · ต้องมีรหัสจากลูกค้า', u.diagnostics.reportsLast7Days),
            tone: (u.diagnostics.access ? 'ok' : 'mute') as string,
          },
          ...u.devices.map((d) => {
            const s = deviceState(d, u.settings.revision, t);
            return { id: d.id, title: `${osLabel(d)} ${short(d.id)}`, sub: s.label, tone: s.tone as string };
          }),
        ]
      : [];
    const cur = items.find((i) => i.id === sel) ?? items[0];
    const device = u?.devices.find((d) => d.id === cur?.id);
    return (
      <div className="split">
        <section className="list" aria-label={t('ผลการค้น')}>
          <div className="lh">
            <h3>{t('ผู้ใช้')}</h3>
            <SearchForm busy={busy} problem={problem} onSearch={lookup} className="us-form us-form-narrow" />
          </div>
          <ul>
            {items.map((it) => (
              <li key={it.id} className={`it us-it${it === cur ? ' sel' : ''}`}>
                <i className={`ic us-${it.tone}`} aria-hidden="true" />
                <button type="button" className="lg-pick" onClick={() => setSel(it.id)} aria-pressed={it === cur}>
                  <b>{it.title}</b>
                </button>
                <small>{it.sub}</small>
              </li>
            ))}
          </ul>
        </section>
        <section className="det" aria-label={t('รายละเอียด')}>
          <div className="lg-detail">
            {!u || !cur ? (
              <Empty />
            ) : cur.id === 'diagnostics' ? (
              <>
                <p className="crumb">{t('ผู้ใช้ / รายงานวินิจฉัย')}</p>
                <h2>{t('รายงานวินิจฉัย')}</h2>
                <SupportDiagnostics key={u.user.id} u={u} />
              </>
            ) : device ? (
              <>
                <p className="crumb">{t('ผู้ใช้ / เครื่อง')}</p>
                <h2>{osLabel(device)}</h2>
                <dl className="us-facts">
                  <div>
                    <dt>{t('รหัสเครื่อง')}</dt>
                    <dd className="mo">{device.id}</dd>
                  </div>
                  <div>
                    <dt>{t('แอป')}</dt>
                    <dd className="mo">{device.appBuild}</dd>
                  </div>
                  <div>
                    <dt>{t('ลงทะเบียน')}</dt>
                    <dd>{formatLogTime(device.createdAt, t.lang)}</dd>
                  </div>
                  <div>
                    <dt>{t('ติดต่อล่าสุด')}</dt>
                    <dd>{formatLogTime(device.lastSeenAt, t.lang)}</dd>
                  </div>
                  <div>
                    <dt>{t('สถานะ')}</dt>
                    <dd>{deviceState(device, u.settings.revision, t).label}</dd>
                  </div>
                </dl>
              </>
            ) : (
              <>
                <p className="crumb">{t('ผู้ใช้ / บัญชี · {0}', matchedLine(u, t))}</p>
                <h2>
                  <StatusBadge u={u} />
                </h2>
                <Facts u={u} />
              </>
            )}
            <Note />
          </div>
        </section>
      </div>
    );
  }

  // Minimal (FinVault cards)
  return (
    <div className="fv-dash us">
      <section className="fv-card" aria-labelledby="fv-us-search">
        <div className="fv-card-head">
          <div>
            <h2 id="fv-us-search">{t('ค้นหาผู้ใช้')}</h2>
            <small>{t('ใช้อีเมลหรือรหัสที่ลูกค้าแจ้ง ดูได้ทีละบัญชี')}</small>
          </div>
        </div>
        {form}
      </section>
      {u ? (
        <>
          <div className="fv-logstats">
            <section className="fv-card">
              <small className="fv-label">{t('บัญชี')}</small>
              <p className="fv-amount us-amount">
                <StatusBadge u={u} />
              </p>
              <small>{matchedLine(u, t)}</small>
            </section>
            <section className="fv-card">
              <small className="fv-label">{t('เครื่องที่ใช้อยู่')}</small>
              <p className="fv-amount">{activeDevices(u).length}</p>
              <small>{t('ทั้งหมด {0} เครื่อง', u.devices.length)}</small>
            </section>
            <section className="fv-card">
              <small className="fv-label">{t('ยังไม่ได้รับการตั้งค่าล่าสุด')}</small>
              <p className={`fv-amount${outOfSync(u) ? ' hot' : ''}`}>{outOfSync(u)}</p>
              <small>{t('การตั้งค่า r{0}', u.settings.revision)}</small>
            </section>
            <section className="fv-card">
              <small className="fv-label">{t('รายงานวินิจฉัย')}</small>
              <p className="fv-amount">{u.diagnostics.reportsLast7Days}</p>
              <small>{t('ใน 7 วัน')}</small>
            </section>
          </div>
          <section className="fv-card" aria-labelledby="fv-us-devices">
            <div className="fv-card-head">
              <div>
                <h2 id="fv-us-devices">{t('เครื่องของผู้ใช้')}</h2>
                <small>{t('เรียงจากที่ติดต่อล่าสุด')}</small>
              </div>
            </div>
            <DeviceTable u={u} />
          </section>
          <section className="fv-card" aria-labelledby="fv-us-account">
            <div className="fv-card-head">
              <div>
                <h2 id="fv-us-account">{t('บัญชี')}</h2>
              </div>
            </div>
            <Facts u={u} />
          </section>
          <section className="fv-card" aria-labelledby="fv-us-diag">
            <div className="fv-card-head">
              <div>
                <h2 id="fv-us-diag">{t('รายงานวินิจฉัย')}</h2>
                <small>{t('ดูได้เมื่อลูกค้าให้รหัส')}</small>
              </div>
            </div>
            <SupportDiagnostics key={u.user.id} u={u} />
          </section>
        </>
      ) : (
        <Empty />
      )}
      <Note />
    </div>
  );
}
