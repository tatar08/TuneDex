'use client';
import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Lang, strings } from '@/lib/i18n';
import { usePlayer } from '../player/Player';
import { ExplorerIcon, useExplorerUI } from '../ExplorerUI';
import type { Card } from './HomeView';

function mark(c: Card) {
  const text = c.name.trim().split(/\s+/).slice(0,2).map(word=>word[0]).join('').toUpperCase();
  let hash = 0; for (const letter of c.name) hash = (hash * 31 + letter.charCodeAt(0)) >>> 0;
  return { text, color: ['#e4572e','#262626','#c6002b','#2f5d62','#fe2c55','#2563eb','#7c3aed','#0f766e'][hash % 8] };
}
/** Reference feed presentation with real metadata and explicit shared-player controls. */
export function ExplorerHome({ lang, items, favorites, recent, countryControl, empty }: { lang: Lang; items: Card[]; favorites: Card[]; recent: Card[]; countryControl: React.ReactNode; empty: string }) {
  const t = strings(lang), th = lang === 'th';
  const { now, status, play, togglePlayback, muted, toggleMute } = usePlayer();
  const ui = useExplorerUI();
  const { source, query, category } = ui;
  const [genre, setGenre] = useState(''), [language, setLanguage] = useState('');
  const [message, setMessage] = useState(''), [info, setInfo] = useState<Card | null>(null);
  const feed = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(0);
  const list = source === 'favorites' ? favorites : source === 'recent' ? recent : items;
  const genres = useMemo(() => [...new Set(list.flatMap(c=>c.genres ?? []))].sort(),[list]);
  const languages = [...new Set(list.map(c=>c.language).filter((x): x is string=>!!x))].sort();
  const shown = list.filter(c => {
    const tags = (c.genres ?? []).join(' ').toLowerCase();
    const categoryMatch = category === 'music' ? /music|jazz|pop|rock|classical|dance|hits|country|hip.?hop|easy listening/.test(tags) : category === 'sports' ? /sport/.test(tags) : category === 'news' ? /news|talk/.test(tags) : true;
    return categoryMatch && (!genre || c.genres?.includes(genre)) && (!language || c.language === language) && `${c.name} ${c.meta} ${c.language ?? ''}`.toLocaleLowerCase(lang).includes(query.toLocaleLowerCase(lang));
  });
  const identity = shown.map(c=>c.key).join('|');
  useEffect(()=> { setGenre(''); setLanguage(''); },[category, source]);
  useEffect(()=> {
    setIndex(0); feed.current?.scrollTo({top:0});
    const root = feed.current; if (!root) return;
    const observer = new IntersectionObserver(entries=>{ for (const entry of entries) if(entry.isIntersecting) setIndex(Number((entry.target as HTMLElement).dataset.index)); },{root,threshold:.65});
    root.querySelectorAll('article').forEach(el=>observer.observe(el)); return ()=>observer.disconnect();
  },[identity, source]);
  const step = (direction: number)=> {
    const next=Math.min(Math.max(index+direction,0),shown.length-1);
    feed.current?.querySelectorAll('article')[next]?.scrollIntoView({block:'nearest',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});
  };
  const copy=async(c:Card)=>{ try{await navigator.clipboard.writeText(c.url);setMessage(th?'คัดลอกลิงก์สตรีมแล้ว':'Stream link copied');}catch{setMessage(th?'คัดลอกไม่ได้ กรุณาอนุญาตคลิปบอร์ด':'Cannot copy. Allow clipboard access.');} };
  const title = query ? (th?'ผลการค้นหา':'Search results') : source === 'browse' ? t.navHome : source === 'favorites' ? t.radioFavorites : source === 'recent' ? t.homeRecent : ({music:th?'เพลง':'Music',sports:th?'กีฬา':'Sports',news:th?'ข่าวและพูดคุย':'News & Talk',location:th?'ตามประเทศ':'By Location',language:th?'ตามภาษา':'By Language'}[category] ?? (th?'สำหรับคุณ':'For You'));
  const state=(c:Card)=>now?.url===c.url ? status==='playing'?t.playerPlaying:status==='paused'?(th?'พักการเล่น':'Paused'):status==='failed'?t.playerFailed:t.playerConnecting : th?'พร้อมฟัง':'Ready to listen';
  const tile=(c:Card)=>{const m=mark(c);return <button key={c.key} className="explorer-tile" type="button" aria-label={t.playerPlay(c.name)} onClick={()=>play(c)}><span className="explorer-tile-art" style={{color:m.color}}>{m.text}<i aria-hidden="true">▶</i></span><b>{c.name}</b><small>{c.meta}</small></button>;};
  const collection=(title:string,cards:Card[])=>cards.length>0&&<section className="explorer-shelf"><h2>{title}</h2><div>{cards.map(tile)}</div></section>;
  return <section className={`explorer-home${source==='browse'||query?' explorer-browse':''}`}>
    <header className="explorer-heading"><h1>{title}</h1><span>· {shown.length} {th?'สถานี':'stations'}</span></header>
    <div className="explorer-top-actions"><Link href="/app/overview" prefetch={false}><ExplorerIcon kind="user"/>{t.navAccount}</Link><Link href="/app/settings" prefetch={false} className="explorer-account-pill">{t.navSettings}</Link></div>
    <details className="explorer-filters" open={category==='language'||category==='location'}><summary>{th?'ตัวกรอง':'Filters'}</summary><div>
      <label>{th?'แนวเพลง':'Genre'}<select value={genre} onChange={e=>setGenre(e.target.value)}><option value="">{th?'ทั้งหมด':'All'}</option>{genres.map(g=><option key={g}>{g}</option>)}</select></label>
      <label>{th?'ภาษา':'Language'}<select value={language} onChange={e=>setLanguage(e.target.value)}><option value="">{th?'ทั้งหมด':'All'}</option>{languages.map(l=><option key={l}>{l}</option>)}</select></label>{countryControl}
    </div></details>
    {source==='browse'||query ? <div className="explorer-browse-content">
      {query ? <div className="explorer-search-results">{shown.map(c=><button type="button" className="explorer-result" key={c.key} aria-label={t.playerPlay(c.name)} onClick={()=>play(c)}><span style={{color:mark(c).color}}>{mark(c).text}</span><div><b>{c.name}</b><small>{c.meta}</small></div><i aria-hidden="true">▶</i></button>)}</div> : <>
      <div className="explorer-heroes">{shown.slice(0,6).map(c=><button key={c.key} style={{background:mark(c).color}} onClick={()=>play(c)} aria-label={t.playerPlay(c.name)}><span className="explorer-hero-ring"/><b>{c.name}</b><small>{th?'ฟังตอนนี้':'LISTEN NOW'}</small></button>)}</div>
      {collection(t.homeRecent,recent)}{collection(t.radioFavorites,favorites)}{collection(th?'ค้นพบสถานี':'Discover stations',shown)}</>}
      {!shown.length&&<p role="status">{query?t.exploreNone:empty}</p>}
    </div> : <div className="explorer-stage">
      <div className="explorer-feed" ref={feed} tabIndex={0} aria-label={th?'ฟีดสถานี':'Station feed'} onKeyDown={e=>{if(e.target!==e.currentTarget)return;if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();step(e.key==='ArrowDown'?1:-1);}else if(e.key===' '&&shown[index]){e.preventDefault();now?.url===shown[index].url?togglePlayback():play(shown[index]);}else if(e.key==='m')toggleMute();}}>
        {!shown.length&&<p className="explorer-empty" role="status">{query||genre||language||category?t.exploreNone:source==='favorites'?t.homeFavoritesNone:source==='recent'?t.homeRecentNone:empty}</p>}
        {shown.map((c,i)=>{const active=now?.url===c.url,playing=active&&status==='playing',m=mark(c);return <article key={c.key} data-index={i} className={playing?'is-playing':''}>
          <div className="explorer-wrap">
            <div className="explorer-card" style={{background:m.color}}>
              <svg viewBox="0 0 400 400" className="explorer-rings" aria-hidden="true">{[60,100,140,180,195].map(r=><circle key={r} cx="200" cy="200" r={r}/>)}</svg>
              <span className="explorer-initials" aria-hidden="true">{m.text}</span>
              <span className="explorer-state" role="status"><i className="explorer-equalizer" aria-hidden="true"><b/><b/><b/></i>{state(c)}</span>
              <button className="explorer-play" type="button" aria-label={t.playerPlay(c.name)} aria-pressed={active} onClick={()=>active&&status!=='failed'?togglePlayback():play(c)}><span aria-hidden="true">▶</span></button>
              <button type="button" className="explorer-mute" aria-label={th?(muted?'เปิดเสียง':'ปิดเสียง'):(muted?'Unmute':'Mute')} aria-pressed={muted} onClick={toggleMute}><ExplorerIcon kind={muted?'muted':'volume'}/></button>
              <div className="explorer-caption"><h2>{c.name}</h2><p>{c.meta} {c.language&&<strong> · {c.language}</strong>}</p></div>
            </div>
            <aside className="explorer-actions" aria-label={c.name}>
              <span className="explorer-avatar" style={{background:m.color}} aria-hidden="true">{m.text}</span>
              <Link href="/app/radio?library=1" prefetch={false} aria-label={t.homeManage} title={t.homeManage}><ExplorerIcon kind="heart"/><small>{th?'สถานีโปรด':'Favourites'}</small></Link>
              <button type="button" onClick={()=>setInfo(c)} aria-label={th?`รายละเอียด ${c.name}`:`Details ${c.name}`}><ExplorerIcon kind="info"/><small>{th?'รายละเอียด':'Details'}</small></button>
              <Link href="/app/radio" prefetch={false} aria-label={t.navRadio}><ExplorerIcon kind="globe"/><small>{t.navRadio}</small></Link>
              <button type="button" onClick={()=>void copy(c)} aria-label={th?`คัดลอกลิงก์ ${c.name}`:`Copy link ${c.name}`}><ExplorerIcon kind="share"/><small>{th?'แชร์':'Share'}</small></button>
              <span className="explorer-disc" style={{backgroundColor:m.color}} aria-hidden="true"/>
            </aside>
          </div>
        </article>;})}
      </div>
      <div className="explorer-steppers"><button type="button" onClick={()=>step(-1)} disabled={!shown.length||index===0} aria-label={th?'สถานีก่อนหน้า':'Previous station'}><ExplorerIcon kind="up"/></button><button type="button" onClick={()=>step(1)} disabled={!shown.length||index===shown.length-1} aria-label={th?'สถานีถัดไป':'Next station'}><ExplorerIcon kind="down"/></button></div>
    </div>}
    {message&&<div className="explorer-toast" role="status">{message}<button aria-label={th?'ปิดข้อความ':'Dismiss'} onClick={()=>setMessage('')}>×</button></div>}
    {info&&<div className="explorer-info" role="dialog" aria-modal="false" aria-label={th?'รายละเอียดสถานี':'Station details'}><button autoFocus aria-label={th?'ปิดรายละเอียด':'Close details'} onClick={()=>setInfo(null)}>×</button><h2>{info.name}</h2><p>{info.meta}</p><p>{info.language}</p><button onClick={()=>play(info)}>{t.playerPlay(info.name)}</button></div>}
  </section>;
}
