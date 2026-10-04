import type { AdminStation, AuditEvent, HealthState, RightsRecord, RightsState, StaffRole, StationHealth } from './bff';

/** The five staff console themes Tar approved on 2026-10-03; each keeps its own layout. Minimal is the default. */
export const THEMES = [
  { id: 'minimal', label: 'Minimal' },
  { id: 'control-room', label: 'Control Room' },
  { id: 'broadcast-rack', label: 'Broadcast Rack' },
  { id: 'daylight-bento', label: 'Daylight Bento' },
  { id: 'workbench', label: 'Workbench' },
] as const;
export type ThemeId = (typeof THEMES)[number]['id'];
export const DEFAULT_THEME: ThemeId = 'minimal';
export const THEME_COOKIE = 'td_admin_theme';
/** Light or dark for the Minimal theme (the other four have a fixed palette). */
export const MODE_COOKIE = 'td_admin_mode';
export type Mode = 'light' | 'dark';
export const modeFrom = (v: string | undefined): Mode => (v === 'dark' ? 'dark' : 'light');
export const themeFrom = (v: string | undefined): ThemeId =>
  (THEMES.some((t) => t.id === v) ? v : DEFAULT_THEME) as ThemeId;

export const ROLE_LABELS: Record<StaffRole, string> = {
  support: 'ซัพพอร์ต',
  catalog_editor: 'บรรณาธิการแค็ตตาล็อก',
  operator: 'โอเปอเรเตอร์',
  admin: 'แอดมิน',
  auditor: 'ผู้ตรวจสอบ',
};

export const STATUS_LABELS: Record<AdminStation['status'], string> = {
  draft: 'ร่าง',
  changes_pending: 'รอตรวจ',
  published: 'เผยแพร่แล้ว',
  disabled: 'ปิดอยู่',
};

export const STATUS_FILTERS = ['all', 'changes_pending', 'draft', 'published', 'disabled'] as const;
export type StatusFilter = (typeof STATUS_FILTERS)[number];
export const FILTER_LABELS: Record<StatusFilter, string> = { all: 'ทั้งหมด', ...STATUS_LABELS };
export const filterFrom = (v: string | undefined): StatusFilter =>
  ((STATUS_FILTERS as readonly string[]).includes(v ?? '') ? v : 'all') as StatusFilter;

export const BLOCKER_LABELS: Record<string, string> = {
  admin_role_required: 'ต้องเป็นแอดมินจึงจะเผยแพร่ได้',
  own_change: 'คุณแก้ร่างนี้เอง ต้องให้แอดมินคนอื่นเป็นผู้เผยแพร่',
  already_published: 'เวอร์ชันนี้เผยแพร่อยู่แล้ว',
  rights_missing: 'ยังไม่มีหลักฐานสิทธิ์ที่ใช้งานอยู่',
  rights_territory: 'หลักฐานสิทธิ์ไม่ครอบคลุมประเทศของสถานี',
  rights_not_yet_valid: 'หลักฐานสิทธิ์ยังไม่ถึงวันเริ่มใช้',
  rights_expired: 'สิทธิ์หมดอายุแล้ว',
};

/** The station's rights at a glance (AdminStation.rights.state). */
export const RIGHTS_STATE_LABELS: Record<RightsState, string> = {
  current: 'มีสิทธิ์ใช้งานอยู่',
  missing: 'ยังไม่มีข้อมูลสิทธิ์',
  territory: 'สิทธิ์ไม่ครอบคลุมประเทศนี้',
  not_yet_valid: 'สิทธิ์ยังไม่เริ่ม',
  expired: 'สิทธิ์หมดอายุแล้ว',
};

/** One rights record's status; "expired" and "scheduled" come from the dates. */
export const RIGHTS_STATUS_LABELS: Record<RightsRecord['effectiveStatus'], string> = {
  active: 'ใช้งานอยู่',
  scheduled: 'ยังไม่ถึงวันเริ่ม',
  expired: 'หมดอายุ',
  revoked: 'เพิกถอนแล้ว',
};

export const RIGHTS_BASIS_LABELS: Record<string, string> = {
  owner_permission: 'ได้รับอนุญาตจากเจ้าของสถานี',
  broadcaster_terms: 'ตามเงื่อนไขของผู้แพร่ภาพ',
  licensed_aggregator: 'ผ่านผู้รวบรวมที่มีใบอนุญาต',
  owned_demo: 'สตรีมสาธิตของเราเอง',
};

export const FIELD_LABELS: Record<string, string> = {
  name: 'ชื่อสถานี',
  country: 'ประเทศ',
  language: 'ภาษา',
  genres: 'แนวเพลง',
  streamUrl: 'ลิงก์สตรีม',
  codec: 'รูปแบบเสียง',
  bitrateKbps: 'บิตเรต (kbps)',
  reason: 'เหตุผล',
};

/** Fields of a rights record (the add form and API validation errors). */
export const RIGHTS_FIELD_LABELS: Record<string, string> = {
  holder: 'เจ้าของสิทธิ์',
  basis: 'ที่มาของสิทธิ์',
  reference: 'เลขอ้างอิงหลักฐาน',
  territories: 'ประเทศที่ครอบคลุม',
  validFrom: 'เริ่มใช้',
  expiresAt: 'สิทธิ์หมดอายุ',
  evidenceRefs: 'รหัสไฟล์หลักฐาน',
  reason: 'เหตุผลที่เพิกถอน',
};

export const REASON_LABELS: Record<string, string> = {
  required: 'ต้องกรอก',
  length: 'ความยาวไม่ถูกต้อง',
  control_characters: 'มีอักขระที่ไม่อนุญาต',
  must_be_url: 'ไม่ใช่ลิงก์ที่ถูกต้อง',
  https_required: 'ต้องเป็นลิงก์ https เท่านั้น',
  credentials_not_allowed: 'ห้ามใส่ชื่อผู้ใช้หรือรหัสผ่านในลิงก์',
  fragment_not_allowed: 'ห้ามมี # ในลิงก์',
  ip_literal_not_allowed: 'ใช้ชื่อโดเมน ห้ามใช้เลข IP',
  private_host: 'โดเมนนี้เป็นเครือข่ายภายใน',
  nonstandard_port: 'ใช้พอร์ต 443 เท่านั้น',
  iso_3166_alpha2: 'ใช้รหัสประเทศ 2 ตัวอักษรพิมพ์ใหญ่ เช่น TH',
  iso_639: 'ใช้รหัสภาษา 2–3 ตัวอักษรพิมพ์เล็ก เช่น th',
  max_5: 'ไม่เกิน 5 แนว',
  slug: 'ใช้ a-z, 0-9 และ - เท่านั้น',
  value_not_allowed: 'ค่าที่เลือกไม่อนุญาต',
  out_of_range: 'ค่าเกินช่วงที่รับได้ (8–512)',
  date_yyyy_mm_dd: 'วันที่ไม่ถูกต้อง',
  too_short: 'สั้นเกินไป อธิบายอย่างน้อย 20 ตัวอักษร',
  before_valid_from: 'วันหมดอายุต้องไม่ก่อนวันเริ่มใช้',
  opaque_key: 'ใช้รหัสไฟล์ในที่เก็บส่วนตัว ห้ามใส่ลิงก์',
  max_10: 'ไม่เกิน 10 รายการ',
  unknown_field: 'ช่องนี้ไม่รองรับแล้ว',
};

const dateFmt = new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium', timeZone: 'Asia/Bangkok' });
const dateTimeFmt = new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Bangkok' });
/** Dates are shown in Thailand time for everyone. */
export const formatDate = (iso: string | null) => (iso ? dateFmt.format(new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso)) : '');
export const formatDateTime = (iso: string | null) => (iso ? dateTimeFmt.format(new Date(iso)) : '');

/** Rights end within 30 days (or already ended), or no record allows the station: worth flagging in lists. */
export function rightsSoon(s: AdminStation, now = Date.now()): boolean {
  if (s.rights.state !== 'current') return true;
  const end = s.rights.expiresAt;
  return !!end && Date.parse(`${end}T23:59:59Z`) - now < 30 * 86_400_000;
}

export const rightsLine = (s: AdminStation) =>
  s.rights.state !== 'current'
    ? RIGHTS_STATE_LABELS[s.rights.state]
    : s.rights.expiresAt
      ? `สิทธิ์ถึง ${formatDate(s.rights.expiresAt)}`
      : 'สิทธิ์ไม่มีวันหมดอายุ';

const LANGUAGE_NAMES: Record<string, string> = { th: 'ไทย', en: 'อังกฤษ', ja: 'ญี่ปุ่น', zh: 'จีน', ko: 'เกาหลี', lo: 'ลาว', my: 'พม่า', km: 'เขมร' };
export const languageName = (code: string) => LANGUAGE_NAMES[code] ?? code.toUpperCase();

/** "jazz · ไทย · TH": genres, language name, country code. */
export const subtitle = (s: AdminStation) =>
  [s.draft.genres.join(', '), languageName(s.draft.language), s.draft.country].filter(Boolean).join(' · ');

export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => [...w][0])
    .join('')
    .toUpperCase();

export function countByStatus(stations: AdminStation[]): Record<StatusFilter, number> {
  const out = { all: stations.length, draft: 0, changes_pending: 0, published: 0, disabled: 0 };
  for (const s of stations) out[s.status]++;
  return out;
}

/** What the apps can see right now: published, enabled, and a rights record still covers the published station. */
export function visibleInApps(s: AdminStation, now = Date.now()): boolean {
  if (!s.published || s.disabledAt) return false;
  const end = s.rights.liveUntil;
  return !end || Date.parse(end) > now;
}

export interface CatalogSummary {
  total: number;
  visible: number;
  pending: number;
  drafts: number;
  disabled: number;
}

export function summarize(stations: AdminStation[]): CatalogSummary {
  const c = countByStatus(stations);
  return { total: c.all, visible: stations.filter((s) => visibleInApps(s)).length, pending: c.changes_pending, drafts: c.draft, disabled: c.disabled };
}

/** Days until the rights end (negative once ended), or null when there is no end date or no record. */
export function rightsDaysLeft(s: AdminStation, now = Date.now()): number | null {
  const end = s.rights.state === 'current' || s.rights.state === 'expired' ? s.rights.expiresAt : null;
  return end ? Math.ceil((Date.parse(`${end}T23:59:59Z`) - now) / 86_400_000) : null;
}

/** What each staff role can open in the console; the API checks the same roles on every call. */
export const canSeeStations = (roles: StaffRole[]) => roles.includes('catalog_editor') || roles.includes('admin');
export const canSeeLogs = (roles: StaffRole[]) => roles.includes('operator') || roles.includes('admin');
export const canSeeAudit = (roles: StaffRole[]) => roles.includes('auditor') || roles.includes('admin');
export const canSeeUsers = (roles: StaffRole[]) => roles.includes('support') || roles.includes('admin');
/** Operators can look at the app configuration; only admins draft, publish or roll it back. */
export const canSeeConfig = (roles: StaffRole[]) => roles.includes('operator') || roles.includes('admin');

/** Doc 17: one log query covers at most 24 hours (older lines: move the window with a page link). */
export const LOG_RANGES = [
  { id: '15m', label: '15 นาทีล่าสุด', ms: 15 * 60_000 },
  { id: '1h', label: '1 ชั่วโมงล่าสุด', ms: 3_600_000 },
  { id: '6h', label: '6 ชั่วโมงล่าสุด', ms: 6 * 3_600_000 },
  { id: '24h', label: '24 ชั่วโมงล่าสุด', ms: 24 * 3_600_000 },
] as const;
export type LogRangeId = (typeof LOG_RANGES)[number]['id'];

export const LOG_LEVELS = [
  { id: '', label: 'ทุกระดับ', severity: '' },
  { id: 'error', label: 'เฉพาะ ERROR', severity: 'ERROR' },
  { id: 'warn', label: 'WARN ขึ้นไป', severity: 'WARN,ERROR' },
] as const;

export const LOG_FIELD_LABELS: Record<string, string> = {
  from: 'ช่วงเวลา',
  to: 'ช่วงเวลา',
  severity: 'ระดับ',
  build: 'build',
  eventCode: 'รหัสเหตุการณ์',
  requestId: 'requestId',
  traceId: 'traceId',
  errorCode: 'รหัสข้อผิดพลาด',
  status: 'HTTP status',
  cursor: 'หน้าถัดไป',
};

export interface LogSearch {
  range: LogRangeId;
  level: string;
  status: string;
  eventCode: string;
  requestId: string;
  traceId: string;
  errorCode: string;
  build: string;
  /** Fixed end of the window while paging, so newer lines do not shift the pages. */
  to: string;
  cursor: string;
}

const pick = (v: string | string[] | undefined, max = 80) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** Reads the search form from the page URL. Values are passed on as text; the API rejects bad ones. */
export function logSearchFrom(sp: Record<string, string | string[] | undefined>): LogSearch {
  const range = LOG_RANGES.find((r) => r.id === sp.range)?.id ?? '1h';
  const level = LOG_LEVELS.find((l) => l.id === sp.level)?.id ?? '';
  return {
    range,
    level,
    status: pick(sp.status, 3),
    eventCode: pick(sp.eventCode, 64).toUpperCase(),
    requestId: pick(sp.requestId, 64),
    traceId: pick(sp.traceId, 32).toLowerCase(),
    errorCode: pick(sp.errorCode, 64),
    build: pick(sp.build, 64),
    to: pick(sp.to, 40),
    cursor: pick(sp.cursor, 120),
  };
}

/** Turns the form into API parameters, ending the window now unless a page link fixed it. */
export function logApiParams(s: LogSearch, now = Date.now()) {
  const toMs = s.to && !Number.isNaN(Date.parse(s.to)) ? Date.parse(s.to) : now;
  const ms = LOG_RANGES.find((r) => r.id === s.range)!.ms;
  return {
    from: new Date(toMs - ms).toISOString(),
    to: new Date(toMs).toISOString(),
    severity: LOG_LEVELS.find((l) => l.id === s.level)!.severity,
    status: s.status,
    eventCode: s.eventCode,
    requestId: s.requestId,
    traceId: s.traceId,
    errorCode: s.errorCode,
    build: s.build,
    cursor: s.cursor,
    limit: '50',
  };
}

/** A link to the log page with these search values (empty ones left out). */
export function logHref(s: Partial<LogSearch>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(s)) if (v && !(k === 'range' && v === '1h')) p.set(k, v);
  const qs = p.toString();
  return qs ? `/admin/logs?${qs}` : '/admin/logs';
}

const logTimeFmt = new Intl.DateTimeFormat('th-TH', {
  timeZone: 'Asia/Bangkok',
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});
export const formatLogTime = (iso: string) => logTimeFmt.format(new Date(iso));

export const AUDIT_RANGES = [
  { id: '24h', label: '24 ชั่วโมงล่าสุด', ms: 24 * 3_600_000 },
  { id: '7d', label: '7 วันล่าสุด', ms: 7 * 86_400_000 },
  { id: '30d', label: '30 วันล่าสุด', ms: 30 * 86_400_000 },
  { id: '90d', label: '90 วันล่าสุด', ms: 90 * 86_400_000 },
] as const;
export type AuditRangeId = (typeof AUDIT_RANGES)[number]['id'];

export const ACTION_LABELS: Record<string, string> = {
  'station.create': 'สร้างร่างสถานี',
  'station.update': 'แก้ร่างสถานี',
  'station.publish': 'เผยแพร่สถานี',
  'station.publish_emergency': 'เผยแพร่สถานีแบบฉุกเฉิน (ไม่มีผู้ตรวจคนที่สอง ต้องตรวจย้อนหลัง)',
  'station.disable': 'ปิดสถานี',
  'station.enable': 'เปิดสถานีอีกครั้ง',
  'station.check': 'ตรวจสตรีม',
  'rights.add': 'เพิ่มหลักฐานสิทธิ์สถานี',
  'rights.revoke': 'เพิกถอนสิทธิ์สถานี',
  'staff_role.grant': 'ให้สิทธิ์ทีมงาน',
  'staff_role.revoke': 'ถอนสิทธิ์ทีมงาน',
  'logs.search': 'ค้นบันทึกระบบ',
  'logs.export': 'ส่งออกบันทึกระบบ',
  'audit.search': 'ดูประวัติการแก้ไข',
  'device.revoke': 'ผู้ใช้ออกจากระบบอุปกรณ์',
  'audit.export': 'ส่งออกประวัติ',
  'account.export': 'ผู้ใช้ดาวน์โหลดข้อมูล',
  'account.delete_requested': 'ผู้ใช้ขอลบบัญชี',
  'account.restore_repurge': 'ลบบัญชีซ้ำหลังกู้ข้อมูล',
  'support.code_created': 'ลูกค้าสร้างรหัสให้ support',
  'support.access_granted': 'support ได้สิทธิ์ดูรายงานวินิจฉัย',
  'support.access_refused': 'รหัสจากลูกค้าใช้ไม่ได้',
  'support.access_revoked': 'ลูกค้ายกเลิกสิทธิ์ support',
  'support.diagnostics_read': 'support เปิดดูรายงานวินิจฉัย',
  'account.deleted': 'ลบข้อมูลบัญชีเสร็จ',
  'job.retry': 'สั่งงานเบื้องหลังซ้ำ',
  'user.lookup': 'เปิดดูข้อมูลผู้ใช้',
  'config.update': 'แก้ร่างตั้งค่าแอป',
  'config.publish': 'เผยแพร่ตั้งค่าแอป',
  'config.rollback': 'ย้อนตั้งค่าแอป',
};
export const actionLabel = (a: string) => ACTION_LABELS[a] ?? a;
/** Family used for colors and the action filter. */
export const actionFamily = (a: string) => a.split('.')[0];
export const AUDIT_FAMILIES = [
  { id: '', label: 'ทุกการกระทำ' },
  { id: 'station', label: 'สถานี' },
  { id: 'rights', label: 'สิทธิ์สถานี' },
  { id: 'staff_role', label: 'สิทธิ์ทีมงาน' },
  { id: 'logs', label: 'การค้นบันทึก' },
  { id: 'audit', label: 'การดูประวัติ' },
  { id: 'config', label: 'ตั้งค่าแอป' },
] as const;

export const AUDIT_FIELD_LABELS: Record<string, string> = {
  from: 'ช่วงเวลา',
  to: 'ช่วงเวลา',
  actor: 'ผู้กระทำ',
  action: 'การกระทำ',
  targetId: 'เป้าหมาย',
  requestId: 'requestId',
  cursor: 'หน้าถัดไป',
};

export interface AuditSearch {
  range: AuditRangeId;
  family: string;
  actor: string;
  targetId: string;
  requestId: string;
  reads: string;
  to: string;
  cursor: string;
}

export function auditSearchFrom(sp: Record<string, string | string[] | undefined>): AuditSearch {
  return {
    range: AUDIT_RANGES.find((r) => r.id === sp.range)?.id ?? '7d',
    family: AUDIT_FAMILIES.find((f) => f.id === sp.family)?.id ?? '',
    actor: pick(sp.actor, 128),
    targetId: pick(sp.targetId, 64),
    requestId: pick(sp.requestId, 64),
    reads: sp.reads === '1' ? '1' : '',
    to: pick(sp.to, 40),
    cursor: pick(sp.cursor, 120),
  };
}

export function auditApiParams(s: AuditSearch, now = Date.now()) {
  const toMs = s.to && !Number.isNaN(Date.parse(s.to)) ? Date.parse(s.to) : now;
  const ms = AUDIT_RANGES.find((r) => r.id === s.range)!.ms;
  return {
    from: new Date(toMs - ms).toISOString(),
    to: new Date(toMs).toISOString(),
    action: s.family,
    actor: s.actor,
    targetId: s.targetId,
    requestId: s.requestId,
    includeReads: s.reads,
    cursor: s.cursor,
    limit: '50',
  };
}

export function auditHref(s: Partial<AuditSearch>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(s)) if (v && !(k === 'range' && v === '7d')) p.set(k, v);
  const qs = p.toString();
  return qs ? `/admin/audit?${qs}` : '/admin/audit';
}

/** Who did it: the account's OIDC subject, or the operator label for staff CLI changes. */
export const actorName = (e: AuditEvent) => e.actorSubject ?? (e.actor.startsWith('operator:') ? `โอเปอเรเตอร์ ${e.actor.slice(9)}` : e.actor);
/** Value for the actor filter that finds this actor again. */
export const actorKey = (e: AuditEvent) => e.actorSubject ?? e.actor.replace(/^user:/, '');

/** One-line, plain-text summary of what changed. */
export function changeSummary(e: AuditEvent): string {
  const c = e.changes ?? {};
  const parts: string[] = [];
  if (Array.isArray(c.fields)) parts.push(`ช่อง: ${(c.fields as string[]).map((f) => FIELD_LABELS[f] ?? f).join(', ')}`);
  if (typeof c.role === 'string') parts.push(`บทบาท: ${ROLE_LABELS[c.role as StaffRole] ?? c.role}`);
  if (c.revision !== undefined) parts.push(`revision ${c.revision}`);
  if (c.previousPublishedRevision !== undefined && c.previousPublishedRevision !== null) parts.push(`แทน r${c.previousPublishedRevision}`);
  if (typeof c.target === 'string') parts.push(c.target === 'draft' ? 'ตรวจสตรีมของร่าง' : 'ตรวจสตรีมที่เผยแพร่');
  if (typeof c.result === 'string') parts.push(`ผล: ${PROBE_REASON_LABELS[c.result] ?? c.result}`);
  for (const [k, v] of Object.entries(c)) {
    if (['fields', 'role', 'revision', 'previousPublishedRevision', 'target', 'result'].includes(k)) continue;
    parts.push(`${k}: ${Array.isArray(v) ? v.join(',') : typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v)}`);
  }
  return parts.join(' · ');
}

const dayFmt = new Intl.DateTimeFormat('th-TH', { timeZone: 'Asia/Bangkok', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
export const formatDay = (iso: string) => dayFmt.format(new Date(iso));

/** Shown when the API answers 429 API_RATE_LIMITED. */
export const RATE_LIMITED = 'ทำรายการถี่เกินไป รอประมาณหนึ่งนาทีแล้วลองใหม่';

export const HEALTH_LABELS: Record<HealthState, string> = {
  unknown: 'ยังไม่ได้ตรวจ',
  ok: 'เล่นได้',
  failing: 'ตรวจไม่ผ่าน',
  suspect: 'น่าสงสัย',
};

/** Probe result codes from the API (stream-probe.ts). */
export const PROBE_REASON_LABELS: Record<string, string> = {
  ok: 'เล่นได้',
  invalid_url: 'ที่อยู่สตรีมไม่ถูกต้อง',
  dns_failed: 'หาโดเมนไม่เจอ',
  blocked_address: 'ชี้ไปที่อยู่ภายในหรือไม่ใช่สาธารณะ',
  timeout: 'ไม่ตอบภายใน 10 วินาที',
  connect_failed: 'เชื่อมต่อไม่ได้',
  http_status: 'เซิร์ฟเวอร์ตอบข้อผิดพลาด',
  too_many_redirects: 'เปลี่ยนเส้นทางเกิน 3 ครั้ง',
  not_audio: 'ไม่ใช่สตรีมเสียง',
};

export const probeReason = (reason: string, httpStatus: number | null) =>
  `${PROBE_REASON_LABELS[reason] ?? reason}${reason === 'http_status' && httpStatus ? ` (${httpStatus})` : ''}`;

/** One line for lists: state plus the latest result when it is not fine. */
export function healthLine(h: StationHealth): string {
  if (h.state === 'unknown') return HEALTH_LABELS.unknown;
  const worst = [...h.regions].sort((a, b) => b.consecutiveFailures - a.consecutiveFailures)[0];
  if (h.state === 'ok') return worst?.latencyMs != null ? `${HEALTH_LABELS.ok} · ${worst.latencyMs} ms` : HEALTH_LABELS.ok;
  return `${HEALTH_LABELS[h.state]} · ${probeReason(worst.reason, worst.httpStatus)} · ${worst.consecutiveFailures} ครั้งติด`;
}

export function countByHealth(stations: AdminStation[]): Record<HealthState, number> {
  const c: Record<HealthState, number> = { unknown: 0, ok: 0, failing: 0, suspect: 0 };
  for (const s of stations) if (isLive(s)) c[healthOf(s).state]++;
  return c;
}

/** Health only matters for stations the apps can see; drafts and disabled stations show none. */
export const isLive = (s: AdminStation) => s.publishedRevision !== null && !s.disabledAt;
export const healthOf = (s: AdminStation): StationHealth => s.health ?? { state: 'unknown', regions: [] };
