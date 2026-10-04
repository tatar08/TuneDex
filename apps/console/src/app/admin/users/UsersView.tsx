'use client';

import { useState } from 'react';
import { canSeeUsers, formatLogTime, RATE_LIMITED } from '@/lib/admin';
import type { UserSupportView } from '@/lib/bff';
import { useAdmin } from '../AdminShell';

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
const DELETION: Record<NonNullable<User['deletion']>['status'], string> = { pending: 'กำลังลบ', failed: 'ลบไม่สำเร็จ กำลังลองใหม่', completed: 'ลบเสร็จแล้ว' };

const deviceState = (d: Device, revision: number) =>
  d.revokedAt
    ? { label: 'ออกจากระบบแล้ว', tone: 'mute' as const }
    : d.inSync
      ? { label: 'ได้รับการตั้งค่าล่าสุดแล้ว', tone: 'ok' as const }
      : { label: `ยังไม่ได้รับการตั้งค่าล่าสุด (ใช้ r${d.appliedSettingsRevision} จาก r${revision})`, tone: 'warn' as const };
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
  const [query, setQuery] = useState('');
  const [reason, setReason] = useState('');
  return (
    <form
      className={className}
      aria-label="ค้นหาผู้ใช้"
      onSubmit={(e) => {
        e.preventDefault();
        onSearch(query, reason);
      }}
    >
      <label className="fld">
        <span>อีเมล รหัสผู้ใช้ หรือรหัสเครื่อง</span>
        <input id="us-query" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="name@example.com หรือ xxxxxxxx-xxxx-…" autoComplete="off" spellCheck={false} required />
      </label>
      <label className="fld">
        <span>เหตุผล (จะถูกบันทึกไว้ในประวัติ)</span>
        <input id="us-reason" value={reason} onChange={(e) => setReason(e.target.value)} minLength={10} maxLength={500} placeholder="เช่น ลูกค้าแจ้งว่าตั้งค่าไม่ซิงก์ เคส #1042" required />
      </label>
      <button type="submit" className="btn" disabled={busy}>
        {busy ? 'กำลังค้น…' : 'ค้นหา'}
      </button>
      {problem && (
        <p role="alert" className="au-export-err us-problem">
          {problem}
        </p>
      )}
    </form>
  );
}

const Note = () => <p className="ov-foot dim">ข้อมูลเท่าที่ซัพพอร์ตต้องใช้ ไม่มีค่าที่ตั้งหรือสถานีของผู้ใช้ · ทุกการค้นถูกบันทึกในประวัติพร้อมเหตุผล (ไม่บันทึกอีเมลที่ค้น)</p>;
const Empty = () => <p className="dim us-empty">ใส่อีเมล รหัสผู้ใช้ หรือรหัสเครื่องที่ลูกค้าแจ้ง พร้อมเหตุผล แล้วกดค้นหา</p>;

function Facts({ u }: { u: User }) {
  return (
    <dl className="us-facts">
      <div>
        <dt>อีเมล</dt>
        <dd>{u.user.email ? `${u.user.email}${u.user.emailVerified ? '' : ' (ยังไม่ยืนยัน)'}` : 'ไม่มี'}</dd>
      </div>
      <div>
        <dt>รหัสผู้ใช้</dt>
        <dd className="mo">{u.user.id}</dd>
      </div>
      <div>
        <dt>สมัครเมื่อ</dt>
        <dd>{formatLogTime(u.user.createdAt)}</dd>
      </div>
      <div>
        <dt>การตั้งค่า</dt>
        <dd>{u.settings.revision ? `r${u.settings.revision} · บันทึก ${formatLogTime(u.settings.updatedAt!)}` : 'ยังไม่เคยบันทึก'}</dd>
      </div>
      <div>
        <dt>รายงานวินิจฉัย 7 วัน</dt>
        <dd>{u.diagnostics.reportsLast7Days} ฉบับ</dd>
      </div>
      <div>
        <dt>การลบบัญชี</dt>
        <dd>{u.deletion ? `${DELETION[u.deletion.status]} · ขอเมื่อ ${formatLogTime(u.deletion.requestedAt)}` : 'ไม่มีคำขอ'}</dd>
      </div>
    </dl>
  );
}

function DeviceTable({ u }: { u: User }) {
  if (u.devices.length === 0) return <p className="dim">ยังไม่มีเครื่องลงทะเบียน</p>;
  return (
    <div className="us-scroll">
      <table className="us-table">
        <caption className="sr-only">เครื่องของผู้ใช้</caption>
        <thead>
          <tr>
            <th scope="col">เครื่อง</th>
            <th scope="col">แอป</th>
            <th scope="col">ติดต่อล่าสุด</th>
            <th scope="col">สถานะ</th>
          </tr>
        </thead>
        <tbody>
          {u.devices.map((d) => {
            const s = deviceState(d, u.settings.revision);
            return (
              <tr key={d.id}>
                <td>
                  {osLabel(d)} <span className="mo dim">{short(d.id)}</span>
                </td>
                <td className="mo">{d.appBuild}</td>
                <td>{formatLogTime(d.lastSeenAt)}</td>
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

const StatusBadge = ({ u, className = 'us-tone' }: { u: User; className?: string }) => (
  <span className={`${className} ${STATUS[u.user.status].tone}`}>{STATUS[u.user.status].label}</span>
);
const matchedLine = (u: User) => (u.matchedBy === 'device' ? 'พบจากรหัสเครื่อง' : u.matchedBy === 'email' ? 'พบจากอีเมล' : 'พบจากรหัสผู้ใช้');
const activeDevices = (u: User) => u.devices.filter((d) => !d.revokedAt);
const outOfSync = (u: User) => activeDevices(u).filter((d) => !d.inSync).length;

export function UsersView() {
  const { theme, roles } = useAdmin();
  const { result: u, problem, busy, lookup } = useLookup();
  const [sel, setSel] = useState('account');
  if (!canSeeUsers(roles)) {
    return (
      <div className="adm-alert" role="alert">
        {PROBLEMS.forbidden}
      </div>
    );
  }
  const form = <SearchForm busy={busy} problem={problem} onSearch={lookup} />;

  if (theme === 'control-room') {
    return (
      <div className="cr-page us">
        <div className="top">
          <div className="crumb">
            Support<b>ผู้ใช้</b>
          </div>
        </div>
        <div className="pn us-search">{form}</div>
        {u ? (
          <>
            <div className="ov-kpis us-kpis">
              <div className="pn">
                <small>บัญชี</small>
                <b>
                  <StatusBadge u={u} />
                </b>
                <span className="dim">{matchedLine(u)}</span>
              </div>
              <div className="pn">
                <small>เครื่องที่ใช้อยู่</small>
                <b className="mo">{activeDevices(u).length}</b>
                <span className="dim">ทั้งหมด {u.devices.length}</span>
              </div>
              <div className={`pn${outOfSync(u) ? ' warn' : ''}`}>
                <small>ยังไม่ได้รับการตั้งค่าล่าสุด</small>
                <b className="mo">{outOfSync(u)}</b>
                <span className="dim">การตั้งค่า r{u.settings.revision}</span>
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
          <h3>ผู้ใช้ · Support Desk</h3>
          <span>ค้นได้ทีละบัญชี พร้อมเหตุผล</span>
        </div>
        <div className="adm-panel">{form}</div>
        {u ? (
          <>
            <div className="ov-lamps">
              <span className="lamp-row">
                <i className={`lamp us-${STATUS[u.user.status].tone}`} aria-hidden="true" /> บัญชี: {STATUS[u.user.status].label} · {matchedLine(u)}
              </span>
              <span className="lamp-row">
                <i className={`lamp us-${outOfSync(u) ? 'warn' : 'ok'}`} aria-hidden="true" /> เครื่องที่ยังไม่ได้รับการตั้งค่าล่าสุด {outOfSync(u)} จาก {activeDevices(u).length}
              </span>
            </div>
            <ul className="us-rack">
              {u.devices.map((d) => {
                const s = deviceState(d, u.settings.revision);
                return (
                  <li key={d.id} className="adm-panel">
                    <span className="lamp-row">
                      <i className={`lamp us-${s.tone}`} aria-hidden="true" />
                      <b>{osLabel(d)}</b> <span className="mo dim">{short(d.id)}</span>
                    </span>
                    <span className="mo">{d.appBuild}</span>
                    <span>ล่าสุด {formatLogTime(d.lastSeenAt)}</span>
                    <span>{s.label}</span>
                  </li>
                );
              })}
            </ul>
            <div className="adm-panel">
              <Facts u={u} />
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
            <h3>ผู้ใช้</h3>
            <p>ช่วยลูกค้าจากรหัสที่เขาแจ้ง ดูได้ทีละบัญชี</p>
          </div>
        </div>
        <div className="us-bento">
          <section className="b-search">{form}</section>
          {u ? (
            <>
              <section className="b-kpi">
                <small>บัญชี</small>
                <StatusBadge u={u} className="hl-pill us-tone" />
                <span>{matchedLine(u)}</span>
              </section>
              <section className={`b-kpi${outOfSync(u) ? ' warn' : ''}`}>
                <small>ยังไม่ได้รับการตั้งค่าล่าสุด</small>
                <b>{outOfSync(u)}</b>
                <span>จาก {activeDevices(u).length} เครื่องที่ใช้อยู่</span>
              </section>
              {u.devices.map((d) => {
                const s = deviceState(d, u.settings.revision);
                return (
                  <section key={d.id} className="b-device">
                    <h4>
                      {osLabel(d)} <span className="dim">{short(d.id)}</span>
                    </h4>
                    <span className={`hl-pill us-tone ${s.tone}`}>{s.label}</span>
                    <small>
                      แอป {d.appBuild} · ล่าสุด {formatLogTime(d.lastSeenAt)}
                    </small>
                  </section>
                );
              })}
              <section className="b-facts">
                <h4>บัญชี</h4>
                <Facts u={u} />
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
          { id: 'account', title: 'บัญชี', sub: STATUS[u.user.status].label, tone: STATUS[u.user.status].tone as string },
          ...u.devices.map((d) => {
            const s = deviceState(d, u.settings.revision);
            return { id: d.id, title: `${osLabel(d)} ${short(d.id)}`, sub: s.label, tone: s.tone as string };
          }),
        ]
      : [];
    const cur = items.find((i) => i.id === sel) ?? items[0];
    const device = u?.devices.find((d) => d.id === cur?.id);
    return (
      <div className="split">
        <section className="list" aria-label="ผลการค้น">
          <div className="lh">
            <h3>ผู้ใช้</h3>
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
        <section className="det" aria-label="รายละเอียด">
          <div className="lg-detail">
            {!u || !cur ? (
              <Empty />
            ) : device ? (
              <>
                <p className="crumb">ผู้ใช้ / เครื่อง</p>
                <h2>{osLabel(device)}</h2>
                <dl className="us-facts">
                  <div>
                    <dt>รหัสเครื่อง</dt>
                    <dd className="mo">{device.id}</dd>
                  </div>
                  <div>
                    <dt>แอป</dt>
                    <dd className="mo">{device.appBuild}</dd>
                  </div>
                  <div>
                    <dt>ลงทะเบียน</dt>
                    <dd>{formatLogTime(device.createdAt)}</dd>
                  </div>
                  <div>
                    <dt>ติดต่อล่าสุด</dt>
                    <dd>{formatLogTime(device.lastSeenAt)}</dd>
                  </div>
                  <div>
                    <dt>สถานะ</dt>
                    <dd>{deviceState(device, u.settings.revision).label}</dd>
                  </div>
                </dl>
              </>
            ) : (
              <>
                <p className="crumb">ผู้ใช้ / บัญชี · {matchedLine(u)}</p>
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
            <h2 id="fv-us-search">ค้นหาผู้ใช้</h2>
            <small>ใช้อีเมลหรือรหัสที่ลูกค้าแจ้ง ดูได้ทีละบัญชี</small>
          </div>
        </div>
        {form}
      </section>
      {u ? (
        <>
          <div className="fv-logstats">
            <section className="fv-card">
              <small className="fv-label">บัญชี</small>
              <p className="fv-amount us-amount">
                <StatusBadge u={u} />
              </p>
              <small>{matchedLine(u)}</small>
            </section>
            <section className="fv-card">
              <small className="fv-label">เครื่องที่ใช้อยู่</small>
              <p className="fv-amount">{activeDevices(u).length}</p>
              <small>ทั้งหมด {u.devices.length} เครื่อง</small>
            </section>
            <section className="fv-card">
              <small className="fv-label">ยังไม่ได้รับการตั้งค่าล่าสุด</small>
              <p className={`fv-amount${outOfSync(u) ? ' hot' : ''}`}>{outOfSync(u)}</p>
              <small>การตั้งค่า r{u.settings.revision}</small>
            </section>
            <section className="fv-card">
              <small className="fv-label">รายงานวินิจฉัย</small>
              <p className="fv-amount">{u.diagnostics.reportsLast7Days}</p>
              <small>ใน 7 วัน</small>
            </section>
          </div>
          <section className="fv-card" aria-labelledby="fv-us-devices">
            <div className="fv-card-head">
              <div>
                <h2 id="fv-us-devices">เครื่องของผู้ใช้</h2>
                <small>เรียงจากที่ติดต่อล่าสุด</small>
              </div>
            </div>
            <DeviceTable u={u} />
          </section>
          <section className="fv-card" aria-labelledby="fv-us-account">
            <div className="fv-card-head">
              <div>
                <h2 id="fv-us-account">บัญชี</h2>
              </div>
            </div>
            <Facts u={u} />
          </section>
        </>
      ) : (
        <Empty />
      )}
      <Note />
    </div>
  );
}
