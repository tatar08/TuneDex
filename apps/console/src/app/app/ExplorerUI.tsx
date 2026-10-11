'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { Lang, strings } from '@/lib/i18n';

export type ExplorerSource = 'all' | 'browse' | 'favorites' | 'recent';
const Context = createContext<{
  query: string; source: ExplorerSource; category: string; dark: boolean; toggleDark: () => void;
  setQuery: (s: string) => void; setSource: (s: ExplorerSource) => void; setCategory: (s: string) => void;
} | null>(null);
export function ExplorerProvider({ children }: { children: React.ReactNode }) {
  const [query, setQuery] = useState('');
  const [source, setSource] = useState<ExplorerSource>('all');
  const [category, setCategory] = useState('');
  const [look, setLook] = useState('system');
  const [systemDark, setSystemDark] = useState(false);
  useEffect(() => {
    try { const saved = localStorage.getItem('tunedeck.explorer.appearance'); if (saved === 'light' || saved === 'dark') setLook(saved); } catch {}
    const media = matchMedia('(prefers-color-scheme: dark)');
    const update = () => setSystemDark(media.matches); update();
    media.addEventListener('change', update); return () => media.removeEventListener('change', update);
  }, []);
  const dark = look === 'dark' || (look === 'system' && systemDark);
  const toggleDark = () => { const next = dark ? 'light' : 'dark'; setLook(next); try { localStorage.setItem('tunedeck.explorer.appearance', next); } catch {} };
  return <Context.Provider value={{ query, setQuery, source, setSource, category, setCategory, dark, toggleDark }}><div className="explorer-ui" data-explorer-look={look}>{children}</div></Context.Provider>;
}
export function useExplorerUI() { return useContext(Context)!; }
export function ExplorerIcon({ kind }: { kind: string }) {
  const paths: Record<string,string> = {
    menu:'M3 6h18M3 12h18M3 18h18', close:'m6 6 12 12M18 6 6 18',
    moon:'M21 12a9 9 0 1 1-9-9 7 7 0 0 0 9 9Z',
    feed:'M4 4h7v7H4zM14 4h6v7h-6zM4 14h7v6H4zM14 14h6v6h-6z',
    home:'m3 11 9-8 9 8M5 10v11h5v-7h4v7h5V10',
    radio:'M5 10a7 7 0 0 1 14 0M2 10a10 10 0 0 1 20 0M12 14v7M10 14a2 2 0 1 0 4 0 2 2 0 0 0-4 0',
    heart:'M12 21S3 15 3 8a5 5 0 0 1 9-3 5 5 0 0 1 9 3c0 7-9 13-9 13Z',
    recent:'M3 11a9 9 0 1 1 2 7M3 3v8h8M12 7v5l4 2',
    music:'M9 18V5l11-2v13M9 7l11-2M9 18a3 3 0 1 1-3-3c2 0 3 1 3 3ZM20 16a3 3 0 1 1-3-3c2 0 3 1 3 3Z',
    sports:'M5 3h14v5a7 7 0 0 1-14 0V3ZM5 5H2v3a4 4 0 0 0 4 4M19 5h3v3a4 4 0 0 1-4 4M12 15v6M7 21h10',
    news:'M3 4h18v16H3zM6 8h5v5H6zM14 8h4M14 12h4M6 16h12',
    map:'m3 5 6-2 6 2 6-2v16l-6 2-6-2-6 2V5ZM9 3v16M15 5v16',
    globe:'M3 12h18M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 0c-6 6-6 12 0 18 6-6 6-12 0-18Z',
    pin:'M12 22S4 14 4 9a8 8 0 1 1 16 0c0 5-8 13-8 13ZM9 9a3 3 0 1 0 6 0 3 3 0 0 0-6 0',
    user:'M8 7a4 4 0 1 0 8 0 4 4 0 0 0-8 0ZM4 22v-2a8 8 0 0 1 16 0v2',
    search:'M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14ZM15 15l7 7',
    more:'M4 12h.01M12 12h.01M20 12h.01',
    share:'M12 15V3m-5 5 5-5 5 5M4 13v8h16v-8',
    save:'M6 3h12v19l-6-4-6 4z',
    info:'M12 8h.01M12 11v6M3 12a9 9 0 1 0 18 0 9 9 0 0 0-18 0',
    volume:'M3 9v6h4l6 4V5L7 9H3ZM17 8a6 6 0 0 1 0 8M20 5a10 10 0 0 1 0 14',
    muted:'M3 9v6h4l6 4V5L7 9H3ZM17 9l5 6M22 9l-5 6',
    up:'m5 15 7-7 7 7', down:'m5 9 7 7 7-7',
  };
  return <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={paths[kind] ?? paths.more}/></svg>;
}
export function ExplorerNav({ lang, csrfToken }: { lang: Lang; csrfToken: string }) {
  const t = strings(lang), path = usePathname(), router = useRouter();
  const ui = useExplorerUI();
  const th = lang === 'th';
  const [open,setOpen] = useState(false);
  const trigger=useRef<HTMLButtonElement>(null), menu=useRef<HTMLElement>(null);
  const close=()=>{setOpen(false);trigger.current?.focus()};
  useEffect(()=>{setOpen(false)},[path]);
  useEffect(()=>{
    if(!open)return;
    menu.current?.querySelector<HTMLButtonElement>('.atlas-menu-close')?.focus();
    const trap=(e:KeyboardEvent)=>{
      if(e.key==='Escape'){e.preventDefault();close()}
      if(e.key!=='Tab')return;
      const nodes=Array.from(menu.current?.querySelectorAll<HTMLElement>('a,button,input')??[]).filter(el=>el.getClientRects().length&&!el.hasAttribute('disabled'));
      const first=nodes[0],last=nodes.at(-1);
      if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus()}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus()}
    };
    document.addEventListener('keydown',trap);return()=>document.removeEventListener('keydown',trap);
  },[open]);
  const browse = (source: ExplorerSource, category = '') => { setOpen(false); ui.setSource(source); ui.setCategory(category); ui.setQuery(''); if(path!=='/app/home')router.push('/app/home'); };
  const button = (source: ExplorerSource, kind: string, label: string, category = '') => <button key={kind} type="button" aria-pressed={path === '/app/home' && ui.source === source && ui.category === category} onClick={() => browse(source, category)}><ExplorerIcon kind={kind}/><span>{label}</span></button>;
  const link = (href: string, kind: string, label: string) => <Link href={href} prefetch={false} aria-current={path === href || (href === '/app/radio' && path === '/app/explore') ? 'page' : undefined}><ExplorerIcon kind={kind}/><span>{label}</span></Link>;
  return <>
    <header className="atlas-header"><button type="button" ref={trigger} aria-label={th?'เปิดเมนูทั้งหมด':'Open all menus'} aria-expanded={open} aria-controls="atlas-menu" onClick={()=>setOpen(!open)}><ExplorerIcon kind="menu"/></button><Link href="/app/home" prefetch={false} onClick={e=>{if(path==='/app/home')e.preventDefault();setOpen(false);ui.setSource('browse');ui.setCategory('');ui.setQuery('')}}>TuneDeck<small>EXPLORER</small></Link><button type="button" aria-label={th?'สลับโหมดสี':'Toggle appearance'} aria-pressed={ui.dark} onClick={ui.toggleDark}><ExplorerIcon kind="moon"/></button></header>
    {open&&<button type="button" className="atlas-menu-shade" aria-label={th?'ปิดเมนู':'Close menu'} onClick={close}/>}
    <nav ref={menu} id="atlas-menu" className="side-nav explorer-nav" data-open={open} aria-label={t.navMenu} onClick={e=>{if((e.target as HTMLElement).closest('a'))setOpen(false)}}>
    <button type="button" className="atlas-menu-close" aria-label={th?'ปิดเมนู':'Close menu'} onClick={close}><ExplorerIcon kind="close"/></button>
    <Link href="/app/home" prefetch={false} className="brand"><span className="explorer-mark" aria-hidden="true"><ExplorerIcon kind="radio"/></span>TuneDeck</Link>
    <label className="explorer-search"><ExplorerIcon kind="search"/><span className="sr-only">{t.exploreSearch}</span><input type="search" placeholder={th ? 'ค้นหา' : 'Search'} value={ui.query} onChange={e => { ui.setSource('all'); ui.setCategory(''); ui.setQuery(e.target.value); if (path !== '/app/home') router.push('/app/home'); }}/></label>
    <div className="explorer-nav-group">
      {button('all','feed',th ? 'สำหรับคุณ' : 'For You')}
      <Link href="/app/home" prefetch={false} aria-current={path === '/app/home' && ui.source === 'browse' ? 'page' : undefined} onClick={e => { if(path==='/app/home')e.preventDefault(); setOpen(false); ui.setSource('browse'); ui.setCategory(''); ui.setQuery(''); }}><ExplorerIcon kind="home"/><span>{t.navHome}</span></Link>
      {link('/app/radio','radio',t.navRadio)}
    </div>
    <div className="explorer-nav-group">
      {button('favorites','heart',t.radioFavorites)}
      {button('recent','recent',t.homeRecent)}
      {link('/app/radio?library=1','save',th?'จัดการคลังและลิงก์ส่วนตัว':'Manage library & private links')}
    </div>
    <div className="explorer-nav-group">
      {button('all','music',th ? 'เพลง' : 'Music','music')}
      {button('all','sports',th ? 'กีฬา' : 'Sports','sports')}
      {button('all','news',th ? 'ข่าวและพูดคุย' : 'News & Talk','news')}
      {button('all','pin',th ? 'ตามประเทศ' : 'By Location','location')}
      {button('all','globe',th ? 'ตามภาษา' : 'By Language','language')}
    </div>
    <div className="explorer-nav-group">
      {link('/app/overview','user',t.navOverview)}
      {link('/app/settings','more',t.navSettings)}
      {link('/app/devices','radio',t.navDevices)}
      {link('/app/privacy','save',t.navPrivacy)}
    </div>
    <form method="post" action="/auth/logout"><input type="hidden" name="csrf" value={csrfToken}/><button type="submit">{t.signOut}</button></form>
<button className="explorer-dark-toggle" type="button" role="switch" aria-checked={ui.dark} onClick={ui.toggleDark}><ExplorerIcon kind="moon"/><span>{th ? 'โหมดมืด' : 'Dark mode'}</span></button>
    <small className="explorer-footer">TuneDeck · Explorer</small>
  </nav>
  <nav className="atlas-bottom-nav" aria-label={th?'เมนูด่วน':'Quick navigation'}>{link('/app/radio','radio',t.navRadio)}{button('favorites','heart',t.radioFavorites)}{button('recent','recent',t.homeRecent)}</nav>
  </>;
}
