'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { formatLogTime, RATE_LIMITED } from '@/lib/admin';
import { COUNTRY_CODES } from '@/app/app/explore/countries';
import type { AdminDirectoryList, AdminDirectoryStation, DirectoryBlock, DirectoryFilter } from '@/lib/bff';
import { countryName } from '@/lib/names';
import { useAdmin, useT } from '../AdminShell';
import { LogoUpload } from '../LogoUpload';

/**
 * Worldwide radio (Radio Browser community directory, Tar 2026-10-05): staff see what users would find for a
 * search and take a station, or a whole stream host, out of the results, e.g. on a rights holder's complaint
 * (Doc 10). Stations users already added stay in their lists. Data is shared; each theme lays it out its own way.
 * Staff can also list a whole country and switch each station on or off (Tar 2026-10-09); off is a station block.
 */
const FEATURED = ['TH', 'JP', 'KR', 'US'];
const EUROPE = 'AD AL AT BA BE BG BY CH CY CZ DE DK EE ES FI FO FR GB GG GI GR HR HU IE IM IS IT JE LI LT LU LV MC MD ME MK MT NL NO PL PT RO RS RU SE SI SK SM UA VA'.split(' ');
const PROBLEMS: Record<string, string> = {
  reason: 'กรอกเหตุผล 10–500 ตัวอักษร',
  value: 'รหัสสถานีต้องเป็น UUID ของ Radio Browser หรือโดเมนต้องเป็นชื่อโฮสต์ เช่น stream.example.com',
  exists: 'รายการนี้ถูกบล็อกไว้แล้ว',
  forbidden: 'บัญชีนี้ไม่มีสิทธิ์ (ต้องเป็นผู้ดูแลแค็ตตาล็อกหรือแอดมิน)',
  expired: 'หมดเวลาใช้งาน เข้าสู่ระบบใหม่แล้วลองอีกครั้ง',
  gone: 'ไม่พบรายการนี้แล้ว',
  rate: RATE_LIMITED,
  down: 'บันทึกไม่ได้ในขณะนี้ ลองใหม่อีกครั้ง',
};

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
};

async function send(path: string, body: object, csrfToken: string): Promise<string | null> {
  try {
    const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify(body) });
    if (res.ok) return null;
    const err = (await res.json().catch(() => ({}))) as { code?: string; details?: { field?: string } };
    if (err.code === 'DIRECTORY_BLOCK_EXISTS') return 'exists';
    if (res.status === 400) return err.details?.field === 'reason' ? 'reason' : 'value';
    return res.status === 403 ? 'forbidden' : res.status === 401 ? 'expired' : res.status === 404 ? 'gone' : res.status === 429 ? 'rate' : 'down';
  } catch {
    return 'down';
  }
}

/** A button that opens a reason box; `fixed` blocks a known station or host, otherwise kind and value are typed in. */
function BlockButton({
  fixed,
  label,
  verb,
  className = 'btn secondary',
}: {
  fixed?: { kind: 'station' | 'host'; value: string; name: string };
  label: string;
  /** The submit button's words; blocking by default. */
  verb?: string;
  className?: string;
}) {
  const { csrfToken, t } = useAdmin();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<'station' | 'host'>('host');
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (open && fixed) ref.current?.focus();
  }, [open, fixed]);

  async function submit(ev: React.FormEvent) {
    ev.preventDefault();
    setBusy(true);
    setProblem('');
    const p = await send('/bff/admin/directory/blocks', { kind: fixed?.kind ?? kind, value: fixed?.value ?? value, reason }, csrfToken);
    setBusy(false);
    if (p) return setProblem(t(PROBLEMS[p]));
    setOpen(false);
    setReason('');
    setValue('');
    router.refresh();
  }

  return (
    <div className="jb-retry">
      <button type="button" className={className} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {label}
      </button>
      {open && (
        <form className="au-export-panel" onSubmit={submit} aria-label={label}>
          {fixed ? (
            <p className="dim">{fixed.kind === 'station' ? t('ซ่อนสถานี “{0}” จากผลค้นหา', fixed.name) : t('ซ่อนทุกสถานีบนโฮสต์ {0} และโดเมนย่อย', fixed.value)}</p>
          ) : (
            <>
              <label className="fld">
                <span>{t('ประเภท')}</span>
                <select value={kind} onChange={(e) => setKind(e.target.value as 'station' | 'host')}>
                  <option value="host">{t('โฮสต์ของสตรีม')}</option>
                  <option value="station">{t('รหัสสถานี Radio Browser')}</option>
                </select>
              </label>
              <label className="fld">
                <span>{kind === 'host' ? t('โฮสต์ เช่น stream.example.com') : t('รหัสสถานี (UUID)')}</span>
                <input value={value} onChange={(e) => setValue(e.target.value)} maxLength={253} required />
              </label>
            </>
          )}
          <label className="fld">
            <span>{t('เหตุผล (จะถูกบันทึกไว้ในประวัติ)')}</span>
            <textarea ref={ref} value={reason} onChange={(e) => setReason(e.target.value)} minLength={10} maxLength={500} rows={3} required />
          </label>
          <small className="dim">{t('ผู้ใช้ที่เพิ่มสถานีนี้ไว้แล้วยังเก็บไว้ในรายการของตัวเองได้ เราไม่ลบรายการของผู้ใช้')}</small>
          {problem && (
            <p role="alert" className="au-export-err">
              {problem}
            </p>
          )}
          <div className="row">
            <button type="submit" className="btn" disabled={busy}>
              {busy ? t('กำลังบันทึก…') : (verb ?? t('บล็อก'))}
            </button>
            <button type="button" className="btn secondary" onClick={() => setOpen(false)}>
              {t('ยกเลิก')}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

function Unblock({ block, label, className = 'btn secondary' }: { block: Pick<DirectoryBlock, 'id' | 'value'>; label?: string; className?: string }) {
  const { csrfToken, t } = useAdmin();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');

  async function submit(ev: React.FormEvent) {
    ev.preventDefault();
    setBusy(true);
    setProblem('');
    const p = await send(`/bff/admin/directory/blocks/${block.id}/remove`, { reason }, csrfToken);
    setBusy(false);
    if (p) return setProblem(t(PROBLEMS[p === 'value' ? 'reason' : p]));
    setOpen(false);
    router.refresh();
  }

  return (
    <div className="jb-retry">
      <button type="button" className={className} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {label ?? t('ยกเลิกบล็อก')}
      </button>
      {open && (
        <form className="au-export-panel" onSubmit={submit} aria-label={t('ยกเลิกบล็อก {0}', block.value)}>
          <label className="fld">
            <span>{t('เหตุผล (จะถูกบันทึกไว้ในประวัติ)')}</span>
            <textarea value={reason} onChange={(e) => setReason(e.target.value)} minLength={10} maxLength={500} rows={2} required autoFocus />
          </label>
          {problem && (
            <p role="alert" className="au-export-err">
              {problem}
            </p>
          )}
          <div className="row">
            <button type="submit" className="btn" disabled={busy}>
              {busy ? t('กำลังบันทึก…') : (label ?? t('ยกเลิกบล็อก'))}
            </button>
            <button type="button" className="btn secondary" onClick={() => setOpen(false)}>
              {t('ปิด')}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

function SearchForm({ filter, className }: { filter: DirectoryFilter; className?: string }) {
  const t = useT();
  const named = (codes: string[]) => codes.map((c) => ({ c, name: countryName(c, t.lang) })).sort((a, b) => a.name.localeCompare(b.name, t.lang));
  const others = named(COUNTRY_CODES.filter((c) => !FEATURED.includes(c) && !EUROPE.includes(c)));
  return (
    <form method="get" action="/admin/directory" className={`dr-search ${className ?? ''}`} role="search">
      <select name="country" defaultValue={filter.country} aria-label={t('ประเทศ')}>
        <option value="">{t('ทุกประเทศ (ค้นด้วยชื่อ)')}</option>
        <optgroup label={t('ประเทศหลัก')}>
          {FEATURED.map((c) => (
            <option key={c} value={c}>
              {countryName(c, t.lang)}
            </option>
          ))}
        </optgroup>
        <optgroup label={t('ยุโรป')}>
          {named(EUROPE).map(({ c, name }) => (
            <option key={c} value={c}>
              {name}
            </option>
          ))}
        </optgroup>
        <optgroup label={t('ประเทศอื่น')}>
          {others.map(({ c, name }) => (
            <option key={c} value={c}>
              {name}
            </option>
          ))}
        </optgroup>
      </select>
      <input type="search" name="q" defaultValue={filter.q} maxLength={80} placeholder={t('ค้นหาชื่อสถานีแบบที่ผู้ใช้เห็น')} aria-label={t('ค้นหาชื่อสถานีแบบที่ผู้ใช้เห็น')} />
      <select name="status" defaultValue={filter.status} aria-label={t('สถานะ')}>
        <option value="all">{t('ทุกสถานะ')}</option>
        <option value="active">{t('เปิดอยู่')}</option>
        <option value="inactive">{t('ปิดอยู่')}</option>
      </select>
      <button type="submit" className="btn secondary">
        {t('ค้นหา')}
      </button>
    </form>
  );
}

const describe = (s: AdminDirectoryStation) => [s.country, s.language, s.codec.toUpperCase(), s.bitrateKbps ? `${s.bitrateKbps} kbps` : null, ...s.genres.slice(0, 3)].filter(Boolean).join(' · ');

/** "13.7563, 100.5018" as copied from Google Maps (a comma or spaces between), or null. */
export function parsePlace(text: string): { lat: number; lon: number } | null {
  const m = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*[,\s]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/.exec(text);
  if (!m) return null;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0) ? { lat, lon } : null;
}

/** Where the station shows on the map, and a box to set it by hand (Radio Browser has no place for many stations). */
function PlaceButton({ s }: { s: AdminDirectoryStation }) {
  const { csrfToken, t } = useAdmin();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(s.geo ? `${s.geo.lat}, ${s.geo.lon}` : '');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const where = s.geo ? `${s.geo.lat.toFixed(4)}, ${s.geo.lon.toFixed(4)}` : '';

  async function save(remove: boolean) {
    const place = remove ? null : parsePlace(text);
    if (!remove && !place) return setProblem(t('พิมพ์ละติจูด, ลองจิจูด เช่น 13.7563, 100.5018'));
    setBusy(true);
    setProblem('');
    const p = await send(`/bff/admin/directory/stations/${s.id}/geo${remove ? '/remove' : ''}`, place ?? {}, csrfToken);
    setBusy(false);
    if (p) return setProblem(t(p === 'value' || p === 'reason' ? 'พิมพ์ละติจูด, ลองจิจูด เช่น 13.7563, 100.5018' : PROBLEMS[p]));
    setOpen(false);
    router.refresh();
  }

  return (
    <div className="jb-retry dr-place">
      <small className="dim">
        {s.geoSource === 'staff' ? t('📍 {0} (ทีมงานใส่)', where) : s.geoSource === 'radio-browser' ? t('📍 {0} (จาก Radio Browser)', where) : t('ไม่มีพิกัด ไม่ขึ้นบนแผนที่')}
      </small>
      <button type="button" className="btn secondary" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {s.geoSource === 'staff' ? t('แก้พิกัด') : t('ใส่พิกัด')}
      </button>
      {open && (
        <form
          className="au-export-panel"
          aria-label={t('พิกัดของ {0}', s.name)}
          onSubmit={(e) => {
            e.preventDefault();
            void save(false);
          }}
        >
          <label className="fld">
            <span>{t('ละติจูด, ลองจิจูด (คัดลอกจาก Google Maps ได้)')}</span>
            <input value={text} onChange={(e) => setText(e.target.value)} inputMode="decimal" placeholder="13.7563, 100.5018" maxLength={40} required autoFocus />
          </label>
          {parsePlace(text) && (
            <a className="dim" href={`https://www.google.com/maps?q=${parsePlace(text)!.lat},${parsePlace(text)!.lon}`} target="_blank" rel="noopener noreferrer">
              {t('ดูตำแหน่งนี้ใน Google Maps')}
            </a>
          )}
          {problem && (
            <p role="alert" className="au-export-err">
              {problem}
            </p>
          )}
          <div className="row">
            <button type="submit" className="btn" disabled={busy}>
              {busy ? t('กำลังบันทึก…') : t('บันทึกพิกัด')}
            </button>
            {s.geoSource === 'staff' && (
              <button type="button" className="btn secondary" disabled={busy} onClick={() => void save(true)}>
                {t('ลบพิกัดที่ใส่เอง')}
              </button>
            )}
            <button type="button" className="btn secondary" onClick={() => setOpen(false)}>
              {t('ยกเลิก')}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

/** The logo the map shows for the station, and a way to upload a better one. */
function StationLogo({ s }: { s: AdminDirectoryStation }) {
  const t = useT();
  return (
    <LogoUpload
      src={s.logoVersion ? `/bff/logos/stations/${s.id}?v=${s.logoVersion}` : '/bff/logos/default'}
      note={s.logoSource === 'staff' ? t('โลโก้ที่ทีมงานอัปโหลด') : s.logoSource === 'radio-browser' ? t('โลโก้จาก Radio Browser (ถ้าโหลดไม่ได้ใช้โลโก้ TuneDeck)') : t('ไม่มีโลโก้ ใช้โลโก้ TuneDeck')}
      uploaded={s.logoSource === 'staff'}
      path={`/bff/admin/directory/stations/${s.id}/logo`}
      name={s.name}
      label={s.logoSource === 'staff' ? t('เปลี่ยนโลโก้') : t('อัปโหลดโลโก้')}
    />
  );
}

/** On or off, and the switch. A station hidden by a host block is switched back on from the block list. */
function StationActions({ s }: { s: AdminDirectoryStation }) {
  const t = useT();
  return (
    <span className="dr-actions">
      <StationLogo s={s} />
      <PlaceButton s={s} />
      <span className={s.active ? 'dr-state on' : 'dr-state off'}>{s.active ? t('เปิดอยู่') : t('ปิดอยู่')}</span>
      {s.active ? (
        <>
          <BlockButton fixed={{ kind: 'station', value: s.id, name: s.name }} label={t('ปิดสถานี')} verb={t('ปิดสถานี')} />
          <BlockButton fixed={{ kind: 'host', value: hostOf(s.streamUrl), name: s.name }} label={t('บล็อกทั้งโฮสต์')} />
        </>
      ) : s.block?.kind === 'station' ? (
        <Unblock block={s.block} label={t('เปิดสถานี')} />
      ) : (
        <small className="dim">{t('ปิดทั้งโฮสต์ {0} · เปิดได้จากรายการที่บล็อก', s.block?.value ?? '')}</small>
      )}
    </span>
  );
}

function SearchNote({ filter, search, searchStatus }: { filter: DirectoryFilter; search: AdminDirectoryList | null; searchStatus?: number }) {
  const t = useT();
  if (!filter.q && !filter.country) return <p className="dim">{t('เลือกประเทศหรือค้นหาชื่อสถานี แล้วเปิดหรือปิดแต่ละสถานีได้ สถานีที่ปิดจะไม่ขึ้นในการค้นหาและบนแผนที่ของผู้ใช้')}</p>;
  if (!search)
    return (
      <p className="adm-alert" role="alert">
        {searchStatus === 503 ? t('การค้นหาวิทยุทั่วโลกยังไม่เปิด (ตั้ง RADIO_BROWSER_BASE_URL) หรือ Radio Browser ไม่ตอบในขณะนี้') : searchStatus === 429 ? t(RATE_LIMITED) : t('ค้นหาไม่ได้ในขณะนี้')}
      </p>
    );
  if (search.stations.length === 0) return <p className="dim">{filter.q ? t('ไม่พบสถานีชื่อ “{0}”', filter.q) : t('ไม่พบสถานี')}</p>;
  const page = (offset: number) => {
    const qs = new URLSearchParams({ status: filter.status, offset: String(offset) });
    if (filter.country) qs.set('country', filter.country);
    if (filter.q) qs.set('q', filter.q);
    return `/admin/directory?${qs}`;
  };
  return (
    <p className="dr-pager dim">
      <span>{t('พบ {0} สถานี · แสดง {1}–{2}', search.total, filter.offset + 1, filter.offset + search.stations.length)}</span>
      {search.truncated && <span>{t('(อ่านได้ถึง 5000 สถานีแรก)')}</span>}
      {filter.offset > 0 && <a href={page(Math.max(0, filter.offset - 100))}>{t('← ก่อนหน้า')}</a>}
      {search.nextOffset !== null && <a href={page(search.nextOffset)}>{t('ถัดไป →')}</a>}
    </p>
  );
}

function Attribution({ search }: { search: AdminDirectoryList | null }) {
  const t = useT();
  return (
    <p className="ov-foot dim">
      {t('ข้อมูลสถานีมาจาก {0} ไม่ใช่แค็ตตาล็อกที่เราคัดเอง ผู้ใช้เป็นคนเลือกเพิ่มเอง · ระบบกรองเฉพาะสตรีม https ที่เล่นได้ · บล็อกมีผลกับการค้นหาครั้งถัดไปทันที', search?.attribution ?? 'Radio Browser')}
    </p>
  );
}

const blockLabel = (b: DirectoryBlock) => (b.kind === 'host' ? 'โฮสต์' : 'สถานี');

export function DirectoryView({
  status,
  blocks,
  filter,
  search,
  searchStatus,
}: {
  status: number;
  blocks?: DirectoryBlock[];
  filter: DirectoryFilter;
  search: AdminDirectoryList | null;
  searchStatus?: number;
}) {
  const { theme, t } = useAdmin();
  const [sel, setSel] = useState(0);
  if (!blocks) {
    return (
      <div className="adm-alert" role="alert">
        {status === 403 ? t('บัญชีนี้ไม่มีสิทธิ์ (ต้องเป็นผู้ดูแลแค็ตตาล็อกหรือแอดมิน)') : status === 429 ? t(RATE_LIMITED) : t('โหลดข้อมูลไม่ได้ในขณะนี้ ลองโหลดหน้าใหม่')}
      </div>
    );
  }
  const stations = search?.stations ?? [];
  const blockLine = (b: DirectoryBlock) => t('{0} · โดย {1} · {2}', b.reason, b.createdBy ?? '—', formatLogTime(b.createdAt, t.lang));

  if (theme === 'control-room') {
    return (
      <div className="cr-page dr">
        <div className="top">
          <div className="crumb">
            Catalog<b>{t('วิทยุทั่วโลก')}</b>
          </div>
          <SearchForm filter={filter} />
        </div>
        <div className="pn">
          <SearchNote filter={filter} search={search} searchStatus={searchStatus} />
          {stations.length > 0 && (
            <table className="jb-table">
              <thead>
                <tr>
                  <th scope="col">{t('สถานี')}</th>
                  <th scope="col">{t('รายละเอียด')}</th>
                  <th scope="col">{t('โฮสต์')}</th>
                  <th scope="col">
                    <span className="sr-only">{t('การทำงาน')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {stations.map((s) => (
                  <tr key={s.id}>
                    <td>{s.name}</td>
                    <td className="dim">{describe(s)}</td>
                    <td className="mo">{hostOf(s.streamUrl)}</td>
                    <td>
                      <StationActions s={s} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="pn">
          <div className="dr-head">
            <b>{t('บล็อกอยู่ {0} รายการ', blocks.length)}</b>
            <BlockButton label={t('+ บล็อกด้วยรหัสหรือโฮสต์')} />
          </div>
          {blocks.length === 0 ? (
            <p className="dim">{t('ยังไม่มีรายการที่บล็อก')}</p>
          ) : (
            <table className="jb-table">
              <thead>
                <tr>
                  <th scope="col">{t('ประเภท')}</th>
                  <th scope="col">{t('ค่า')}</th>
                  <th scope="col">{t('เหตุผล')}</th>
                  <th scope="col">{t('โดย')}</th>
                  <th scope="col">{t('เมื่อ')}</th>
                  <th scope="col">
                    <span className="sr-only">{t('การทำงาน')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {blocks.map((b) => (
                  <tr key={b.id}>
                    <td>{t(blockLabel(b))}</td>
                    <td className="mo">{b.value}</td>
                    <td>{b.reason}</td>
                    <td className="mo">{b.createdBy ?? '—'}</td>
                    <td className="mo">{formatLogTime(b.createdAt, t.lang)}</td>
                    <td>
                      <Unblock block={b} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <Attribution search={search} />
      </div>
    );
  }

  if (theme === 'broadcast-rack') {
    return (
      <div className="br-page dr">
        <div className="ttl">
          <h3>{t('วิทยุทั่วโลก')} · Radio Browser</h3>
          <span>{t('บล็อกอยู่ {0} รายการ', blocks.length)}</span>
        </div>
        <div className="br-pick">
          <SearchForm filter={filter} />
        </div>
        <SearchNote filter={filter} search={search} searchStatus={searchStatus} />
        {stations.length > 0 && (
          <ul className="jb-rack">
            {stations.map((s) => (
              <li key={s.id} className="adm-panel">
                <span className="lamp-row">
                  <i className="lamp jb-completed" aria-hidden="true" />
                  <b>{s.name}</b>
                </span>
                <span className="mo">{describe(s)}</span>
                <span className="mo dim">{hostOf(s.streamUrl)}</span>
                <StationActions s={s} />
              </li>
            ))}
          </ul>
        )}
        <div className="ttl">
          <h3>{t('รายการที่บล็อก')}</h3>
          <BlockButton label={t('+ บล็อกด้วยรหัสหรือโฮสต์')} />
        </div>
        {blocks.length === 0 ? (
          <p className="dim">{t('ยังไม่มีรายการที่บล็อก')}</p>
        ) : (
          <ul className="jb-rack">
            {blocks.map((b) => (
              <li key={b.id} className="adm-panel">
                <span className="lamp-row">
                  <i className="lamp jb-dead_letter" aria-hidden="true" />
                  <b>
                    {t(blockLabel(b))} <span className="mo">{b.value}</span>
                  </b>
                </span>
                <span className="dim">{blockLine(b)}</span>
                <Unblock block={b} />
              </li>
            ))}
          </ul>
        )}
        <Attribution search={search} />
      </div>
    );
  }

  if (theme === 'daylight-bento') {
    return (
      <div className="db-page dr">
        <div className="hello">
          <div>
            <h3>{t('วิทยุทั่วโลก')}</h3>
            <p>{t('สถานีจากชุมชน Radio Browser ที่ผู้ใช้ค้นแล้วเพิ่มเอง · บล็อกอยู่ {0} รายการ', blocks.length)}</p>
          </div>
          <BlockButton label={t('+ บล็อกด้วยรหัสหรือโฮสต์')} />
        </div>
        <div className="search">
          <SearchForm filter={filter} />
        </div>
        <SearchNote filter={filter} search={search} searchStatus={searchStatus} />
        <div className="jb-bento">
          {stations.map((s) => (
            <section key={s.id} className="b-job">
              <h4>{s.name}</h4>
              <small>{describe(s)}</small>
              <small className="mo dim">{hostOf(s.streamUrl)}</small>
              <StationActions s={s} />
            </section>
          ))}
          {blocks.map((b) => (
            <section key={b.id} className="b-job">
              <h4>
                {t('บล็อก{0}', t(blockLabel(b)))} <span className="mo">{b.value}</span>
              </h4>
              <small>{blockLine(b)}</small>
              <Unblock block={b} />
            </section>
          ))}
          {blocks.length === 0 && (
            <section className="b-wide">
              <p className="dim">{t('ยังไม่มีรายการที่บล็อก')}</p>
            </section>
          )}
        </div>
        <Attribution search={search} />
      </div>
    );
  }

  if (theme === 'workbench') {
    const cur = blocks[Math.min(sel, blocks.length - 1)];
    return (
      <div className="split">
        <section className="list" aria-label={t('รายการที่บล็อก')}>
          <div className="lh">
            <h3>
              {t('วิทยุทั่วโลก')} <span>{blocks.length}</span>
            </h3>
            <SearchForm filter={filter} className="wb-seg" />
            <BlockButton label={t('+ บล็อกด้วยรหัสหรือโฮสต์')} className="btn" />
          </div>
          {blocks.length === 0 ? (
            <div className="lh">
              <p className="dim">{t('ยังไม่มีรายการที่บล็อก')}</p>
            </div>
          ) : (
            <ul>
              {blocks.map((b, i) => (
                <li key={b.id} className={`it jb-it${b === cur ? ' sel' : ''}`}>
                  <i className="ic jb-dead_letter" aria-hidden="true" />
                  <button type="button" className="lg-pick" onClick={() => setSel(i)} aria-pressed={b === cur}>
                    <b className="mo">{b.value}</b>
                  </button>
                  <span className="r">{t(blockLabel(b))}</span>
                  <small>{b.reason}</small>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="det" aria-label={t('รายละเอียด')}>
          <div className="lg-detail">
            {cur && (
              <>
                <p className="crumb">
                  {t('วิทยุทั่วโลก')} / {t(blockLabel(cur))}
                </p>
                <h2 className="mo">{cur.value}</h2>
                <p>{blockLine(cur)}</p>
                <Unblock block={cur} />
              </>
            )}
            <h3>{t('ผลค้นหาแบบที่ผู้ใช้เห็น')}</h3>
            <SearchNote filter={filter} search={search} searchStatus={searchStatus} />
            {stations.length > 0 && (
              <ul className="ov-list">
                {stations.map((s) => (
                  <li key={s.id}>
                    <span className="ov-inc">
                      <b>{s.name}</b>
                      <small>
                        {describe(s)} · <span className="mo">{hostOf(s.streamUrl)}</span>
                      </small>
                    </span>
                    <StationActions s={s} />
                  </li>
                ))}
              </ul>
            )}
            <Attribution search={search} />
          </div>
        </section>
      </div>
    );
  }

  // Minimal (FinVault cards)
  return (
    <div className="fv-dash dr">
      <section className="fv-card" aria-labelledby="fv-dir-search">
        <div className="fv-card-head">
          <div>
            <h2 id="fv-dir-search">{t('วิทยุทั่วโลก')}</h2>
            <small>{t('สถานีจากชุมชน Radio Browser ที่ผู้ใช้ค้นแล้วเพิ่มเอง')}</small>
          </div>
          <SearchForm filter={filter} />
        </div>
        <SearchNote filter={filter} search={search} searchStatus={searchStatus} />
        {stations.length > 0 && (
          <ul className="ov-list">
            {stations.map((s) => (
              <li key={s.id}>
                <span className="ov-sev ok" aria-hidden="true">
                  ♪
                </span>
                <span className="ov-inc">
                  <b>{s.name}</b>
                  <small>
                    {describe(s)} · <span className="mo">{hostOf(s.streamUrl)}</span>
                  </small>
                </span>
                <StationActions s={s} />
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="fv-card" aria-labelledby="fv-dir-blocks">
        <div className="fv-card-head">
          <div>
            <h2 id="fv-dir-blocks">{t('รายการที่บล็อก')}</h2>
            <small>{t('บล็อกอยู่ {0} รายการ', blocks.length)}</small>
          </div>
          <BlockButton label={t('+ บล็อกด้วยรหัสหรือโฮสต์')} className="fv-outline" />
        </div>
        {blocks.length === 0 ? (
          <p className="dim">{t('ยังไม่มีรายการที่บล็อก')}</p>
        ) : (
          <ul className="ov-list">
            {blocks.map((b) => (
              <li key={b.id}>
                <span className="ov-sev critical" aria-hidden="true">
                  ⦸
                </span>
                <span className="ov-inc">
                  <b>
                    {t(blockLabel(b))} <span className="mo">{b.value}</span>
                  </b>
                  <small>{blockLine(b)}</small>
                </span>
                <Unblock block={b} className="fv-outline" />
              </li>
            ))}
          </ul>
        )}
      </section>
      <Attribution search={search} />
    </div>
  );
}
