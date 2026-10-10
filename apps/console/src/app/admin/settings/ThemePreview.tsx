import type { WebThemeId } from '@/lib/web-themes';

/** Local vector thumbnails of layouts, not invented station data or remote artwork. */
export function ThemePreview({ theme }: { theme: WebThemeId }) {
  const kind: string = theme;
  const maps = ['map-home', 'night-garden', 'tune-world'].includes(theme);
  const tuning = ['signal-dial', 'head-unit', 'tune-world'].includes(theme);
  const panel = ['listen-find', 'country-window'].includes(theme);
  const extra = ['listen-find', 'country-window', 'stage', 'cockpit', 'head-unit', 'signal-dial', 'tune-world', 'language-lanes', 'map-home', 'night-garden', 'daylight'].includes(theme);
  if (extra) return <svg viewBox="0 0 180 104" className={`theme-preview preview-${theme}`} aria-hidden="true">
    <rect x="1" y="1" width="178" height="102" rx="8" fill={maps || ['cockpit','head-unit'].includes(theme) ? '#0f172a' : '#f7f4ee'} stroke="#cbd5e1" />
    <rect x="8" y="8" width="164" height="7" rx="3" fill={maps ? '#34d399' : '#0f172a'}/>
    {maps ? <><path d="M12 35l24-12 17 10-3 18-19 8-8-12zM62 31l25-9 19 16-13 14-11 22-15-9zM111 28l31 4 21 22-18 8-13-15-18 8z" fill={kind==='night-garden'?'#355a52':'#334155'}/><circle cx="98" cy="54" r="5" fill="#34d399"/><rect x="130" y="23" width="35" height="55" rx="4" fill="#111e31"/></> : panel ? <><rect x="8" y="23" width="106" height="9" rx="4" fill="#e2e8f0"/>{[40,54,68].map(y=><rect key={y} x="8" y={y} width="106" height="9" rx="3" fill="#fff" stroke="#cbd5e1"/>)}<rect x="123" y="20" width="48" height="66" rx="4" fill="#0f172a"/><circle cx="147" cy="43" r="12" fill="#10b981"/>{kind==='country-window'&&[0,1,2].map(i=><rect key={i} x={8+i*36} y="82" width="29" height="6" fill="#10b981"/>)}</> : kind==='language-lanes' ? <>{[0,1,2].map(i=><g key={i}><rect x={8+i*56} y="24" width="50" height="61" rx="4" fill="#fff" stroke="#cbd5e1"/>{[34,49,64].map(y=><rect key={y} x={13+i*56} y={y} width="40" height="8" fill={y===34?'#10b981':'#e2e8f0'}/>)}</g>)}</> : kind==='daylight' ? <><rect x="8" y="25" width="140" height="7" fill="#0f172a"/><rect x="8" y="40" width="164" height="25" rx="4" fill="#10b981"/><rect x="8" y="72" width="100" height="12" fill="#e2e8f0"/><rect x="117" y="72" width="55" height="12" fill="#e2e8f0"/></> : <><rect x="8" y="24" width={kind==='cockpit'?110:164} height={kind==='stage'?45:36} rx="6" fill="#334155"/><circle cx="44" cy="42" r="12" fill="#10b981"/>{kind==='cockpit'&&<rect x="126" y="24" width="46" height="36" rx="5" fill="#e2e8f0"/>}{[0,1,2,3,4,5].map(i=><rect key={i} x={8+i*28} y="76" width="23" height="9" rx="2" fill="#10b981"/>)}</>}
    {tuning&&<path d="M8 66h164M20 63v6M48 63v6M76 63v6M104 63v6M132 63v6M160 63v6" stroke="#34d399"/>}
    <rect x="2" y="91" width="176" height="11" rx={kind==='night-garden'?5:2} fill="#0f172a"/><circle cx="91" cy="96" r="3" fill="#10b981"/>
  </svg>;
  const side = ['radio-wall', 'shelves', 'studio'].includes(theme);
  const x = side ? 37 : 12;
  return <svg viewBox="0 0 180 104" className={`theme-preview preview-${theme}`} aria-hidden="true">
    <rect x="1" y="1" width="178" height="102" rx="8" fill="#f7f4ee" stroke="#cbd5e1"/>
    {side ? <><rect x="2" y="2" width="27" height="88" rx="6" fill="#0f172a"/>{[18, 30, 42, 70].map(y => <rect key={y} x="8" y={y} width="14" height="3" rx="1" fill="#e2e8f0"/>)}</> : <rect x="8" y="8" width="164" height="9" rx="3" fill="#0f172a"/>}
    <rect x={x} y="24" width="62" height="4" rx="2" fill="#0f172a"/>
    {kind === 'classic' ? <rect x="36" y="35" width="108" height="46" rx="6" fill="#fff" stroke="#cbd5e1"/> : kind === 'studio' ? <>
      {[0,1,2].map(i => <rect key={i} x={x+i*44} y="34" width="38" height="29" rx="4" fill={i === 1 ? '#0f172a' : '#10b981'}/>)}
      {[0,1,2,3].map(i => <rect key={i} x={x+i*33} y="70" width="28" height="15" rx="3" fill="#fff" stroke="#cbd5e1"/>)}
    </> : kind === 'shelves' ? <>{[37,64].map(y => [0,1,2,3].map(i => <rect key={`${y}-${i}`} x={x+i*33} y={y} width="28" height="21" rx="3" fill={i === 0 ? '#10b981' : '#fff'} stroke="#cbd5e1"/>))}</> : <>
      {[0,1].map(row => Array.from({length: kind === 'preset-wall' ? 4 : 3}, (_, i) => <rect key={`${row}-${i}`} x={x+i*(kind === 'preset-wall' ? 30 : 44)} y={36+row*25} width={kind === 'preset-wall' ? 25 : 38} height="20" rx="3" fill={i === 0 && row === 0 ? '#10b981' : '#fff'} stroke="#cbd5e1"/>))}
      {kind === 'preset-wall' && <rect x="140" y="35" width="29" height="48" rx="4" fill="#e2e8f0"/>}
    </>}
    <rect x="2" y="91" width="176" height="11" rx="3" fill="#0f172a"/><circle cx="91" cy="96" r="3" fill="#10b981"/>
  </svg>;
}
