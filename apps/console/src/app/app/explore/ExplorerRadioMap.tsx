'use client';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { ExplorerIcon } from '../ExplorerUI';
import { useState } from 'react';
import type { MapStation, MapListStation } from '@/lib/bff';
import { Lang, strings } from '@/lib/i18n';
const WorldMap = dynamic(()=>import('./WorldMap').then(m=>m.WorldMap),{ssr:false});
const WorldGlobe = dynamic(()=>import('./WorldGlobe').then(m=>m.WorldGlobe),{ssr:false});
const initials=(name:string)=>name.trim().split(/\s+/).slice(0,2).map(w=>w[0]).join('').toUpperCase();
/** The supplied Radio map layout, using real directory coordinates and explicit playback. */
export function ExplorerRadioMap({lang,stations,unmapped,selected,loading,failed,filter,setFilter,genre,setGenre,genres,select,play,add,note,onGroup,group,clearGroup}:{lang:Lang;stations:MapStation[];unmapped:MapListStation[];selected:MapListStation|null;loading:boolean;failed:boolean;filter:string;setFilter:(s:string)=>void;genre:string;setGenre:(s:string)=>void;genres:string[];select:(s:MapListStation)=>void;play:(s:MapListStation)=>void;add:(s:MapListStation)=>void;note:string;onGroup:(s:MapStation[])=>void;group:Set<string>|null;clearGroup:()=>void}){
 const t=strings(lang),th=lang==='th';const [search,setSearch]=useState(false);const [globe,setGlobe]=useState(false);const [noGlobe,setNoGlobe]=useState(false);
 const [zoom,setZoom]=useState({sequence:0,direction:1});
 const globeView=globe&&!noGlobe;
 const all=[...stations,...unmapped];
 const related=group?all.filter(s=>group.has(s.id)):selected?all.filter(s=>s.id!==selected.id&&s.genres.some(g=>selected.genres.includes(g))):all;
 const chips=Array.from(new Set([...genres,'music','classical','country','top40','rock','news','talk','sports','emergency','religion']));
 return <main className="explorer-radio-map" data-view={globeView?'globe':'map'} aria-label={t.navRadio}>
  {globeView?<WorldGlobe stations={stations} selected={selected?.id??null} onSelect={select} onFail={()=>setNoGlobe(true)} fit={false} reference zoomRequest={zoom} palette={{ocean:'#c4c8ce',land:'#ffffff',border:'#c9d4eb',dot:'#ff8a29',dotOn:'#fe2c55',glow:'#c9d4eb'}}/>:<WorldMap stations={stations} selected={selected?.id??null} onSelect={select} onGroup={onGroup} fit={false} reference labels={{zoomIn:t.exploreZoomIn,zoomOut:t.exploreZoomOut,group:t.exploreGroup}}/>}
  <div className="explorer-map-bar">
   <button className="explorer-map-view" aria-label={globeView?t.exploreMap:t.exploreGlobe} title={globeView?t.exploreMap:t.exploreGlobe} aria-pressed={globeView} onClick={()=>{setGlobe(!globeView);setNoGlobe(false);setZoom({sequence:0,direction:1})}}><ExplorerIcon kind={globeView?'map':'globe'}/></button>
   <button className="explorer-map-search-toggle" aria-expanded={search} onClick={()=>setSearch(!search)}>{th?'ค้นหา':'SEARCH'}</button>
   <div role="group" aria-label={t.exploreGenres} className="explorer-map-genres">{['',...chips].map(g=><button key={g} aria-pressed={genre===g} onClick={()=>setGenre(g)}>{g?g.toUpperCase():th?'ทั้งหมด':'ALL MUSIC'}</button>)}</div>
   <Link href="/app/radio?library=1">{th?'คลังของฉัน':'MY LIBRARY'}</Link>
  </div>
  {globeView&&<div className="explorer-globe-zoom"><button aria-label={t.exploreZoomIn} title={t.exploreZoomIn} onClick={()=>setZoom(z=>({sequence:z.sequence+1,direction:1}))}>+</button><button aria-label={t.exploreZoomOut} title={t.exploreZoomOut} onClick={()=>setZoom(z=>({sequence:z.sequence+1,direction:-1}))}>−</button></div>}
  {search&&<div className="explorer-map-search-box"><input autoFocus type="search" aria-label={t.exploreSearch} placeholder={t.exploreSearch} value={filter} onChange={e=>setFilter(e.target.value)}/><button onClick={()=>{setFilter('');setSearch(false)}}>{th?'ปิด':'Close'}</button><ul>{all.slice(0,20).map(s=><li key={s.id}><button onClick={()=>{select(s);setSearch(false)}}>{s.name}</button></li>)}</ul></div>}
  {noGlobe&&<p className="explorer-map-notice" role="alert">{t.exploreNoGlobe}</p>}
  {(loading||failed||(!loading&&!all.length))&&<p className="explorer-map-notice" role={failed?'alert':'status'}>{failed?t.exploreError:loading?t.exploreLoading:t.exploreNoMatch}</p>}
  <section className="explorer-map-similar" aria-label={th?'สถานีวิทยุ':'Radio stations'}>
   {selected&&<div className="explorer-map-selected" data-testid="explore-pick"><b>{selected.name}</b><span>{[selected.country,selected.genres.join(', ')].filter(Boolean).join(' · ')}</span><button aria-label={t.explorePlay} onClick={()=>play(selected)}>{t.explorePlay}</button><button onClick={()=>add(selected)}>{t.exploreAdd}</button></div>}
   {group&&<button onClick={clearGroup}>{(th?'แสดงทั้งหมด':'Show all')}</button>}
   <b>{selected?(th?'สถานีแนวเดียวกัน':'SIMILAR STATIONS'):(th?'เลือกสถานีเพื่อฟัง':'CHOOSE A STATION')}</b>
   <div className="explorer-map-stations">{related.slice(0,12).map(s=><button key={s.id} title={s.name} aria-label={t.playerPlay(s.name)} onClick={()=>{select(s);play(s)}}>{initials(s.name)}</button>)}</div>
   {note&&<p role="status">{note}</p>}
  </section>
  <small className="explorer-map-attribution">Natural Earth · {t.exploreSource}</small>
 </main>;
}
