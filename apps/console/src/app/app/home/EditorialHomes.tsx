'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Lang, strings } from '@/lib/i18n';
import { countryName } from '@/lib/names';
import { usePlayer } from '../player/Player';
import type { Card } from './HomeView';
import { ThemeMap } from './ThemeMap';
export function MapHome({lang,country,countryControl,items,favorites,recent,garden}:{lang:Lang;country:string;countryControl:React.ReactNode;items:Card[];favorites:Card[];recent:Card[];garden:boolean}) {
 const t=strings(lang),{play}=usePlayer();const [selected,setSelected]=useState<Card|null>(null);useEffect(()=>setSelected(null),[country]);
 const candidate=selected??items[0]??null;
 const shortcuts=(list:Card[],title:string,empty:string)=><section className="map-shortcuts"><h2>{title}</h2>{list.length?<ul>{list.slice(0,6).map(s=><li key={s.key}><button type="button" onClick={()=>play(s)} aria-label={t.playerPlay(s.name)}>{s.name}</button></li>)}</ul>:<p className="status">{empty}</p>}</section>;
 return <div className={garden?'map-home-layout garden-home-layout':'map-home-layout'}><header><h1>{t.homeExplore}</h1>{countryControl}<Link href="/app/radio" prefetch={false}>{t.homeManage}</Link></header><div className="map-home-content"><ThemeMap dark lang={lang} country={country} selected={selected?.key??null} onSelect={setSelected}/><aside className="map-home-sidebar"><section className="station-focus"><p>{t.stationSelected}</p><h2>{candidate?.name??t.listenChoose}</h2><p>{candidate?.meta}</p>{candidate&&<button className="btn" type="button" onClick={()=>play(candidate)} aria-label={t.playerPlay(candidate.name)}>{t.playerPlay(candidate.name)}</button>}</section>{!favorites.length && shortcuts(items,t.homeCurated,t.radioCatalogNone)}{shortcuts(favorites,t.radioFavorites,t.homeFavoritesNone)}{shortcuts(recent,t.homeRecent,t.homeRecentNone)}<Link href="/app/explore" prefetch={false}>{t.homeExplore}</Link></aside></div></div>;
}
export function DaylightHome({lang,country,countryControl,items,popular,favorites}:{lang:Lang;country:string;countryControl:React.ReactNode;items:Card[];popular:boolean;favorites:Card[]}){
 const t=strings(lang),{play}=usePlayer();const feature=items[0]??null;
 const row=(s:Card)=><li key={s.key}><span>{s.name}</span><small>{s.meta}</small><button type="button" onClick={()=>play(s)} aria-label={t.playerPlay(s.name)}>{t.playerPlay(s.name)}</button></li>;
 return <div className="daylight-home"><header><p>{t.homeTitle}</p><h1>{t.countryHeading(countryName(country,lang))}</h1>{countryControl}</header><section className="daylight-feature" aria-label={t.homeCurated}><p>{popular?t.homePopularNote:t.homeCurated}</p><h2>{feature?.name??t.listenChoose}</h2><p>{feature?.meta}</p>{feature&&<button className="btn" type="button" onClick={()=>play(feature)} aria-label={t.playerPlay(feature.name)}>{t.playerPlay(feature.name)}</button>}</section><div className="daylight-columns"><section><h2>{popular?t.homePopular:t.homeCurated}</h2><ul>{items.slice(1).map(row)}</ul></section><section><h2>{t.radioFavorites}</h2>{favorites.length?<ul>{favorites.map(row)}</ul>:<p className="status">{t.homeFavoritesNone}</p>}<Link href="/app/radio" prefetch={false}>{t.homeManage}</Link></section></div><Link href="/app/explore" prefetch={false}>{t.homeExplore}</Link></div>;
}
