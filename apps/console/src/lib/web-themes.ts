/**
 * Layout themes of the web app (Tar 2026-10-11). Staff choose one for every visitor on /admin/settings; a visitor
 * chooses only a colour. Every theme shares the pages, the data and the player; a theme changes the frame around
 * them (where the menu and the player sit) and the home page. Phones keep one layout whatever the theme.
 */
export const WEB_THEMES = [
  { id: 'classic', group: 'classic', name: 'ดั้งเดิม', hint: 'การ์ดกลางจอ เมนูด้านบน แบบที่ใช้มาตลอด' },
  { id: 'radio-wall', group: 'joint', name: 'ผนังวิทยุส่วนตัว', hint: 'เมนูด้านข้าง หน้าแรกเป็นผนังปุ่มสถานี ตัวเล่นเป็นแถบล่างทุกหน้า' },
  { id: 'preset-wall', group: 'codex', name: 'ผนังพรีเซ็ต', hint: 'เมนูด้านบน ปุ่มสถานีสี่คอลัมน์ พร้อมพื้นที่ค้นพบวิทยุข้างกัน' },
  { id: 'shelves', group: 'claude', name: 'ชั้นวางฟังเพลง', hint: 'เมนูด้านข้าง ชั้นสถานีโปรด ฟังล่าสุด และยอดนิยมในประเทศที่เลือก' },
  { id: 'studio', group: 'frames', name: 'สตูดิโอ', hint: 'เมนูด้านข้าง การ์ดสถานีเด่นสามใบ และชั้นสถานีในพื้นที่สว่าง' },
  { id: 'listen-find', group: 'codex', name: 'ค้นหาซ้าย ฟังขวา', hint: 'ค้นหาสถานีด้านซ้าย แผงฟังด้านขวาอยู่ที่เดิมทุกหน้า' },
  { id: 'country-window', group: 'joint', name: 'หน้าต่างประเทศ', hint: 'เลือกประเทศเอง รายการสถานีและพรีเซ็ตหกช่อง พร้อมแผงฟังด้านขวา' },
  { id: 'stage', group: 'frames', name: 'เวที', hint: 'เวทีสถานีขนาดใหญ่บนหน้าแรก และแถบเล่นต่อเนื่องในหน้าอื่น' },
  { id: 'cockpit', group: 'claude', name: 'แผงหน้าปัดรถ', hint: 'แผงสถานีและข้อมูลคอลเลกชัน พรีเซ็ตหกช่องในเบราว์เซอร์ โทนเข้ม' },
  { id: 'head-unit', group: 'frames', name: 'หน้าปัดวิทยุรถ', hint: 'เลือกสถานีด้วยแถบตำแหน่ง กดเล่นแยกต่างหาก พรีเซ็ตในเบราว์เซอร์ โทนเข้ม' },
  { id: 'signal-dial', group: 'codex', name: 'แถบจูนสัญญาณ', hint: 'เลื่อนเลือกตำแหน่งสถานีโดยไม่เล่นอัตโนมัติ ตัวเล่นอยู่ด้านล่าง' },
  { id: 'tune-world', group: 'joint', name: 'จูนรอบโลก', hint: 'สถานีที่เลือก แผนที่จริง และแถบจูน โทนเข้ม' },
  { id: 'language-lanes', group: 'codex', name: 'ทางแยกภาษา', hint: 'สามคอลัมน์ภาษา เลือกภาษาและแนวเพลงแต่ละช่องแยกกัน' },
  { id: 'map-home', group: 'claude', name: 'แผนที่คือหน้าแรก', hint: 'แผนที่เต็มพื้นที่ แผงสถานีโปรดและฟังล่าสุด โทนเข้ม' },
  { id: 'night-garden', group: 'frames', name: 'สวนกลางคืน', hint: 'แผนที่ในสวนสีเข้ม ชั้นสถานีโปรดและฟังล่าสุด ตัวเล่นแบบแคปซูล' },
  { id: 'daylight', group: 'claude', name: 'นิตยสารกลางวัน', hint: 'ประเทศที่คุณเลือกเป็นหัวเรื่อง สถานีเด่นและชั้นรายการ อ่านได้ทั้งสว่างและมืด' },
] as const;
export const WEB_THEME_GROUPS = [
  { id: 'classic', name: 'แบบดั้งเดิม' },
  { id: 'claude', name: 'แบบของ Claude' },
  { id: 'codex', name: 'แบบของ Codex' },
  { id: 'joint', name: 'ออกแบบร่วมกัน' },
  { id: 'frames', name: 'ชุดสตูดิโอและเวที' },
] as const;
export type WebThemeId = (typeof WEB_THEMES)[number]['id'];
export const DEFAULT_WEB_THEME: WebThemeId = 'classic';
/** The theme for an id from the API; one this build does not know (a newer or removed theme) shows the default. */
export const webThemeFrom = (id: string | null | undefined): WebThemeId => WEB_THEMES.find((t) => t.id === id)?.id ?? DEFAULT_WEB_THEME;

/** Colours a visitor can choose on /app/settings; kept in a cookie of their browser, never sent to the API. */
export const WEB_ACCENTS = [
  { id: 'default', name: 'accentDefault', swatch: '#fb9f23' },
  { id: 'green', name: 'accentGreen', swatch: '#10b981' },
  { id: 'blue', name: 'accentBlue', swatch: '#3b82f6' },
  { id: 'rose', name: 'accentRose', swatch: '#f43f5e' },
  { id: 'violet', name: 'accentViolet', swatch: '#8b5cf6' },
] as const;
export type WebAccentId = (typeof WEB_ACCENTS)[number]['id'];
export const ACCENT_COOKIE = 'td_web_accent';
export const webAccentFrom = (id: string | null | undefined): WebAccentId => WEB_ACCENTS.find((a) => a.id === id)?.id ?? 'default';
