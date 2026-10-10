import type { WebThemeId } from '@/lib/web-themes';

/** Local vector thumbnails of layouts, not invented station data or remote artwork. */
export function ThemePreview({ theme }: { theme: WebThemeId }) {
  const side = ['radio-wall', 'shelves', 'studio'].includes(theme);
  const x = side ? 37 : 12;
  return <svg viewBox="0 0 180 104" className={`theme-preview preview-${theme}`} aria-hidden="true">
    <rect x="1" y="1" width="178" height="102" rx="8" fill="#f7f4ee" stroke="#cbd5e1"/>
    {side ? <><rect x="2" y="2" width="27" height="88" rx="6" fill="#0f172a"/>{[18, 30, 42, 70].map(y => <rect key={y} x="8" y={y} width="14" height="3" rx="1" fill="#e2e8f0"/>)}</> : <rect x="8" y="8" width="164" height="9" rx="3" fill="#0f172a"/>}
    <rect x={x} y="24" width="62" height="4" rx="2" fill="#0f172a"/>
    {theme === 'classic' ? <rect x="36" y="35" width="108" height="46" rx="6" fill="#fff" stroke="#cbd5e1"/> : theme === 'studio' ? <>
      {[0,1,2].map(i => <rect key={i} x={x+i*44} y="34" width="38" height="29" rx="4" fill={i === 1 ? '#0f172a' : '#10b981'}/>)}
      {[0,1,2,3].map(i => <rect key={i} x={x+i*33} y="70" width="28" height="15" rx="3" fill="#fff" stroke="#cbd5e1"/>)}
    </> : theme === 'shelves' ? <>{[37,64].map(y => [0,1,2,3].map(i => <rect key={`${y}-${i}`} x={x+i*33} y={y} width="28" height="21" rx="3" fill={i === 0 ? '#10b981' : '#fff'} stroke="#cbd5e1"/>))}</> : <>
      {[0,1].map(row => Array.from({length: theme === 'preset-wall' ? 4 : 3}, (_, i) => <rect key={`${row}-${i}`} x={x+i*(theme === 'preset-wall' ? 30 : 44)} y={36+row*25} width={theme === 'preset-wall' ? 25 : 38} height="20" rx="3" fill={i === 0 && row === 0 ? '#10b981' : '#fff'} stroke="#cbd5e1"/>))}
      {theme === 'preset-wall' && <rect x="140" y="35" width="29" height="48" rx="4" fill="#e2e8f0"/>}
    </>}
    <rect x="2" y="91" width="176" height="11" rx="3" fill="#0f172a"/><circle cx="91" cy="96" r="3" fill="#10b981"/>
  </svg>;
}
