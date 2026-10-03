import type { AdminStation, StaffRole } from './bff';

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
  rights_basis_missing: 'ยังไม่ได้ระบุที่มาของสิทธิ์',
  rights_reference_missing: 'ยังไม่มีเลขอ้างอิงหลักฐานสิทธิ์',
  rights_expired: 'สิทธิ์หมดอายุแล้ว',
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
  rightsBasis: 'ที่มาของสิทธิ์',
  rightsReference: 'เลขอ้างอิงหลักฐาน',
  rightsExpiresAt: 'สิทธิ์หมดอายุ',
  reason: 'เหตุผล',
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
};

const dateFmt = new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium', timeZone: 'Asia/Bangkok' });
const dateTimeFmt = new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Bangkok' });
/** Dates are shown in Thailand time for everyone. */
export const formatDate = (iso: string | null) => (iso ? dateFmt.format(new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso)) : '');
export const formatDateTime = (iso: string | null) => (iso ? dateTimeFmt.format(new Date(iso)) : '');

/** Rights end within 30 days (or already ended): worth flagging in lists. */
export function rightsSoon(s: AdminStation, now = Date.now()): boolean {
  const end = s.draft.rightsExpiresAt;
  return !!end && Date.parse(`${end}T23:59:59Z`) - now < 30 * 86_400_000;
}

export const rightsLine = (s: AdminStation) =>
  s.draft.rightsExpiresAt ? `สิทธิ์ถึง ${formatDate(s.draft.rightsExpiresAt)}` : s.draft.rightsBasis ? 'สิทธิ์ไม่มีวันหมดอายุ' : 'ยังไม่มีข้อมูลสิทธิ์';

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

/** What the apps can see right now: published, enabled, and the published rights have not ended. */
export function visibleInApps(s: AdminStation, now = Date.now()): boolean {
  if (!s.published || s.disabledAt) return false;
  const end = s.published.rightsExpiresAt;
  return !end || Date.parse(`${end}T23:59:59Z`) >= now;
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

/** Days until the rights end (negative once ended), or null when there is no end date. */
export function rightsDaysLeft(s: AdminStation, now = Date.now()): number | null {
  const end = s.draft.rightsExpiresAt;
  return end ? Math.ceil((Date.parse(`${end}T23:59:59Z`) - now) / 86_400_000) : null;
}
