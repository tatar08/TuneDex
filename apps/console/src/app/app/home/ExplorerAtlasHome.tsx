'use client';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { Lang, strings } from '@/lib/i18n';
import { ExplorerIcon, useExplorerUI } from '../ExplorerUI';
import { usePlayer } from '../player/Player';
import type { Card } from './HomeView';

/** Atlas collections use the same catalog, owner-bound favourites and shared player as desktop. */
export function ExplorerAtlasHome({lang,items,favorites,recent,countryControl,empty}:{lang:Lang;items:Card[];favorites:Card[];recent:Card[];countryControl:React.ReactNode;empty:string}) {
 const t=strings(lang),th=lang==='th',ui=useExplorerUI();
 const {now,status,play,togglePlayback}=usePlayer();
 const [genre,setGenre]=useState(''),[language,setLanguage]=useState(''),[detail,setDetail]=useState<Card|null>(null);
 const dialog=useRef<HTMLDialogElement>(null),origin=useRef<HTMLElement|null>(null);
 useEffect(()=>{setGenre('');setLanguage('')},[ui.category,ui.source]);
 useEffect(()=>{if(detail&&!dialog.current?.open)dialog.current?.showModal()},[detail]);
 const source=ui.source==='favorites'?favorites:ui.source==='recent'?recent:items;
 const shown=source.filter(c=>{
  const tags=(c.genres??[]).join(' ').toLowerCase();
  const cat=ui.category==='music'?/music|jazz|pop|rock|classical|dance|hits|country|hip.?hop|easy listening/.test(tags):ui.category==='sports'?/sport/.test(tags):ui.category==='news'?/news|talk/.test(tags):true;
  return cat&&(!genre||c.genres?.includes(genre))&&(!language||c.language===language)&&`${c.name} ${c.meta} ${c.language??''}`.toLocaleLowerCase(lang).includes(ui.query.toLocaleLowerCase(lang));
 });
 const title=ui.query?(th?'ผลการค้นหา':'Search results'):ui.source==='favorites'?t.radioFavorites:ui.source==='recent'?t.homeRecent:ui.source==='browse'?t.navHome:({music:th?'เพลง':'Music',sports:th?'กีฬา':'Sports',news:th?'ข่าวและพูดคุย':'News & Talk',location:th?'ตามประเทศ':'By Country',language:th?'ตามภาษา':'By Language'}[ui.category]??(th?'สำหรับคุณ':'For You'));
 const initials=(c:Card)=>c.name.trim().split(/\s+/).slice(0,2).map(w=>w[0]).join('').toUpperCase();
 const choose=(category:string)=>{ui.setSource('all');ui.setCategory(category);ui.setQuery('')};
 const show=(c:Card,e:React.MouseEvent<HTMLElement>)=>{origin.current=e.currentTarget;setDetail(c)};
 const close=()=>{dialog.current?.close();setDetail(null);origin.current?.focus()};
 const row=(c:Card)=><article key={c.key} className="atlas-station" data-testid="atlas-station"><button type="button" className="atlas-station-detail" aria-label={th?`รายละเอียด ${c.name}`:`Details ${c.name}`} onClick={e=>show(c,e)}><span className="atlas-art">{initials(c)}</span><span><b>{c.name}</b><small>{c.meta}</small></span></button><button type="button" className="atlas-row-play" aria-label={t.playerPlay(c.name)} aria-pressed={now?.url===c.url} onClick={()=>now?.url===c.url&&status!=='failed'?togglePlayback():play(c)}><span aria-hidden="true">{now?.url===c.url&&status==='playing'?'Ⅱ':'▶'}</span></button></article>;
 const featured=shown[0];
 const broad=!ui.query&&!ui.category&&['all','browse'].includes(ui.source);
 return <section className="atlas-home" aria-label={title}>
  <header><small>EXPLORER</small><h1>{title}</h1><p>{th?'ค้นพบเสียงที่ใช่ จากทุกมุมโลก':'Find your sound, from around the world'}</p></header>
  <label className="atlas-search"><ExplorerIcon kind="search"/><input type="search" aria-label={t.exploreSearch} placeholder={th?'ชื่อสถานี หรือแนวเพลง':'Station name or genre'} value={ui.query} onChange={e=>ui.setQuery(e.target.value)}/></label>
  <details className="atlas-filters" open={ui.category==='location'||ui.category==='language'}><summary>{th?'ตัวกรองและประเทศ':'Filters & country'}</summary><div>{countryControl}<label>{th?'แนวเพลง':'Genre'}<select value={genre} onChange={e=>setGenre(e.target.value)}><option value="">{th?'ทั้งหมด':'All'}</option>{Array.from(new Set(source.flatMap(c=>c.genres??[]))).sort().map(g=><option key={g}>{g}</option>)}</select></label><label>{th?'ภาษา':'Language'}<select value={language} onChange={e=>setLanguage(e.target.value)}><option value="">{th?'ทั้งหมด':'All'}</option>{Array.from(new Set(source.map(c=>c.language).filter(Boolean))).sort().map(l=><option key={l}>{l}</option>)}</select></label></div></details>
  {broad&&<div className="atlas-home-columns"><div><section className="atlas-hero"><small>{th?'โลกทั้งใบในคลื่นเดียว':'A WORLD OF RADIO'}</small><h2>{featured?.name??(th?'ค้นหาคลื่นที่ใช่':'Find your station')}</h2><p>{featured?.meta??(th?'เริ่มเดินทางบนแผนที่วิทยุ':'Explore stations on the map')}</p>{featured&&<button type="button" className="btn" aria-label={t.playerPlay(featured.name)} onClick={()=>play(featured)}>{th?'ฟังตอนนี้':'Listen now'}</button>}<Link href="/app/radio" prefetch={false}>{th?'เปิดแผนที่วิทยุ':'Open radio map'} →</Link></section><h2>{th?'เลือกตามความสนใจ':'Browse by interest'}</h2><div className="atlas-categories">{[['music','music',th?'เพลง':'Music'],['news','news',th?'ข่าวและพูดคุย':'News & Talk'],['sports','sports',th?'กีฬา':'Sports'],['location','pin',th?'ตามประเทศ':'By Country'],['language','globe',th?'ตามภาษา':'By Language']].map(([cat,icon,label])=><button type="button" key={cat} onClick={()=>choose(cat)}><ExplorerIcon kind={icon}/><b>{label}</b></button>)}</div></div><section><h2>{th?'กลับมาฟังต่อ':'Listen again'}</h2>{recent.length?recent.slice(0,3).map(row):<p className="status">{t.homeRecentNone}</p>}<h2>{t.radioFavorites}</h2>{favorites.length?favorites.slice(0,3).map(row):<p className="status">{t.homeFavoritesNone}</p>}<Link href="/app/radio?library=1" prefetch={false}>{th?'จัดการคลังและลิงก์ส่วนตัว':'Manage library & private links'} →</Link></section></div>}
  <section className="atlas-collection"><h2>{broad?(th?'ค้นพบสถานี':'Discover stations'):title} <small>· {shown.length}</small></h2>{shown.length?shown.map(row):<div className="atlas-empty" role="status"><ExplorerIcon kind="radio"/><p>{ui.query||genre||language||ui.category?t.exploreNone:ui.source==='favorites'?t.homeFavoritesNone:ui.source==='recent'?t.homeRecentNone:empty}</p><Link href="/app/radio" prefetch={false}>{t.navRadio} →</Link></div>}</section>
  <dialog ref={dialog} className="atlas-dialog" aria-label={th?'รายละเอียดสถานี':'Station details'} onCancel={close} onClose={()=>{setDetail(null);origin.current?.focus()}}>{detail&&<><button type="button" className="atlas-dialog-close" aria-label={th?'ปิดรายละเอียด':'Close details'} onClick={close}><ExplorerIcon kind="close"/></button><span className="atlas-detail-art">{initials(detail)}</span><h2>{detail.name}</h2><p>{detail.meta}</p><p>{detail.language}</p><button type="button" className="btn" aria-label={t.playerPlay(detail.name)} onClick={()=>play(detail)}>{t.playerPlay(detail.name)}</button><Link href="/app/radio?library=1" prefetch={false} onClick={close}>{th?'จัดการสถานีโปรด':'Manage favourites'}</Link></>}</dialog>
 </section>;
}
