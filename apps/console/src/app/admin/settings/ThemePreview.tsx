import type { WebThemeId } from '@/lib/web-themes';

/** Screenshots of actual Home layouts, with disposable fixture data (public/theme-previews/manifest.json). */
export function ThemePreview({ theme }: { theme: WebThemeId }) {
  // eslint-disable-next-line @next/next/no-img-element -- precompressed local static screenshots, no image proxy
  return <img className={`theme-preview preview-${theme}`} src={`/theme-previews/${theme}.webp`} alt="" width={1360} height={860} loading="lazy" decoding="async" />;
}
