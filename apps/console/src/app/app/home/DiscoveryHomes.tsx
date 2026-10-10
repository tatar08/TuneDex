'use client';
import Link from 'next/link';
import { useState } from 'react';
import { Lang, strings } from '@/lib/i18n';
import { languageName } from '@/lib/names';
import { usePlayer } from '../player/Player';
import type { Card } from './HomeView';
import { ThemeMap } from './ThemeMap';
export function TuningHome({lang,items,country,countryControl,world}:{lang:Lang;items:Card[];country:string;countryControl:React.ReactNode;world:boolean}) {
  const t=strings(lang),{play,now}=usePlayer();
  const [selected,setSelected]=useState<Card|null>(null),[query,setQuery]=useState('');
  const shown=items.filter(c=>c.name.toLocaleLowerCase(lang).includes(query.toLocaleLowerCase(lang)));
  const candidate=selected && shown.some(c=>c.url===selected.url)?shown.find(c=>c.url===selected.url)!:selected?.key.startsWith('map:')?selected:shown[0]??null;
  const index=candidate?shown.findIndex(c=>c.url===candidate.url):-1;
  const move=(step:number)=>{const next=shown[Math.max(0,Math.min(shown.length-1,index+step))];if(next)setSelected(next);};
  return <div className={world?'tuning-home world-tuning-home':'tuning-home'}>
    <header><h1>{t.homeTitle}</h1><Link href="/app/explore" prefetch={false}>{t.homeExplore}</Link></header>
    <label>{t.exploreSearch}<input type="search" value={query} onChange={e=>setQuery(e.target.value)}/></label>{countryControl}
    <div className="tuning-focus-layout"><section className="station-focus" aria-label={t.stationSelected}><p>{t.stationSelected}</p><h2>{candidate?.name??t.listenChoose}</h2><p>{candidate?.meta}</p>{index>=0 && <p>{t.stationPosition(index+1,shown.length)}</p>}{candidate && <button className="btn" type="button" aria-label={t.playerPlay(candidate.name)} onClick={()=>play(candidate)}>{t.playerPlay(candidate.name)}</button>}<p className="status">{now?t.playerNow(now.name):t.listenChoose}</p></section>
    {world && <ThemeMap dark lang={lang} country={country} selected={candidate?.key.replace(/^map:/,'')??null} onSelect={s=>setSelected({...s,key:`map:${s.key}`})}/>}</div>
    <section className="tuning-stations" aria-label={t.stationSelected}><div className="tuning-arrows"><button type="button" disabled={index<=0} onClick={()=>move(-1)}>{t.stationPrevious}</button><button type="button" disabled={index<0 || index>=shown.length-1} onClick={()=>move(1)}>{t.stationNext}</button></div><ol>{shown.map((s,i)=><li key={s.key}><button type="button" aria-pressed={candidate?.url===s.url} onClick={()=>setSelected(s)}>{i+1} · {s.name}</button></li>)}</ol>{!shown.length && <p role="status">{t.noSearchMatches}</p>}</section>
  </div>;
}
function Lane({lang,items,initial}:{lang:Lang;items:Card[];initial:string}){
 const t=strings(lang),{play}=usePlayer();const languages=[...new Set(items.map(s=>s.language).filter((x):x is string=>!!x))].sort();const [language,setLanguage]=useState(initial),[genre,setGenre]=useState('');
 const chosen=languages.includes(language)?language:languages.includes(initial)?initial:languages[0]??'';
 const genres=[...new Set(items.filter(s=>s.language===chosen).flatMap(s=>s.genres??[]))].sort();
 const shown=items.filter(s=>s.language===chosen&&(!genre || s.genres?.includes(genre)));
 return <section className="language-lane"><label>{t.language}<select value={chosen} onChange={e=>{setLanguage(e.target.value);setGenre('');}}><option value="" disabled>{t.noSearchMatches}</option>{languages.map(l=><option key={l} value={l}>{languageName(l,lang)}</option>)}</select></label><label>{t.exploreGenres}<select value={genre} onChange={e=>setGenre(e.target.value)}><option value="">{t.exploreAllGenres}</option>{genres.map(g=><option key={g}>{g}</option>)}</select></label><ul>{shown.map(s=><li key={s.key}><h2>{s.name}</h2><p>{s.meta}</p><button type="button" onClick={()=>play(s)} aria-label={t.playerPlay(s.name)}>{t.playerPlay(s.name)}</button></li>)}</ul>{!shown.length&&<p className="status">{t.noSearchMatches}</p>}</section>;
}
export function LanguageHome({lang,items}:{lang:Lang;items:Card[]}){
 const t=strings(lang);const choices=[...new Set(items.map(s=>s.language).filter((x):x is string=>!!x))];
 return <div className="language-home"><header><h1>{t.languagesTitle}</h1><Link href="/app/radio" prefetch={false}>{t.radioFavorites}</Link><Link href="/app/explore" prefetch={false}>{t.homeExplore}</Link></header><div className="language-lanes">{[0,1,2].map(i=><Lane key={i} lang={lang} items={items} initial={choices[i]??''}/>)}</div></div>;
}
