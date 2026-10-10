/**
 * Layout themes of the web app (Tar 2026-10-11). Staff choose one for every visitor on /admin/settings; a visitor
 * chooses only a colour. Every theme shares the pages, the data and the player; a theme changes the frame around
 * them (where the menu and the player sit) and the home page. Phones keep one layout whatever the theme.
 */
export const WEB_THEMES = [
  { id: 'classic', name: 'ดั้งเดิม', hint: 'การ์ดกลางจอ เมนูด้านบน แบบที่ใช้มาตลอด' },
  { id: 'radio-wall', name: 'ผนังวิทยุส่วนตัว', hint: 'เมนูด้านข้าง หน้าแรกเป็นผนังปุ่มสถานี ตัวเล่นเป็นแถบล่างทุกหน้า' },
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
