'use client';
import dynamic from 'next/dynamic';
import { useEffect, useState } from 'react';
import type { MapStation } from '@/lib/bff';
import { Lang, strings } from '@/lib/i18n';
import { countryName } from '@/lib/names';
import type { Card } from './HomeView';
import { logoSrc } from '../explore/logo';
const WorldMap = dynamic(() => import('../explore/WorldMap').then(m=>m.WorldMap), { ssr: false });
/** Real coordinates only; map selection is separate from playback. Bundled outlines, no remote tiles. */
export function ThemeMap({ lang, country, selected, onSelect }: { lang: Lang; country: string; selected: string | null; onSelect: (c: Card)=>void }) {
  const t = strings(lang);
  const [stations, setStations] = useState<MapStation[]>([]);
  const [state,setState] = useState<'loading'|'ready'|'failed'>('loading');
  const [group,setGroup] = useState<MapStation[]>([]);
  useEffect(()=>{let live=true;setStations([]);setGroup([]);setState('loading');const abort=new AbortController();
    fetch(`/bff/directory/map?country=${encodeURIComponent(country)}`,{signal:abort.signal}).then(async res=>{if(res.status===401){location.assign('/login?returnTo=/app/home');return;}if(!res.ok)throw Error(String(res.status));const body=await res.json();if(live){setStations(Array.isArray(body.stations)?body.stations:[]);setState('ready');}}).catch(()=>{if(live)setState('failed');});
    return ()=>{live=false;abort.abort();};
  },[country]);
  const select=(s:MapStation)=>onSelect({key:s.id,name:s.name,url:s.streamUrl,hls:s.codec==='hls',logo:logoSrc(s),language:s.language,genres:s.genres,meta:[countryName(s.country??country,lang),s.genres.slice(0,2).join(', ')].filter(Boolean).join(' · ')});
  return <section className="theme-map explore-app" data-look="auto" aria-label={t.homeExplore}>
    <div className="theme-map-canvas"><WorldMap stations={stations} selected={selected} onSelect={select} onGroup={setGroup} fit labels={{zoomIn:t.exploreZoomIn,zoomOut:t.exploreZoomOut,group:t.exploreGroup}} /></div>
    {state!=='ready' || !stations.length ? <p className="status" role="status">{state==='loading'?t.exploreLoading:state==='failed'?t.exploreError:t.exploreNone}</p>:null}
    {group.length>0 && <div className="map-group-list"><p>{t.exploreGroupShown(group.length)}</p>{group.map(s=><button type="button" key={s.id} onClick={()=>select(s)}>{s.name}</button>)}</div>}
  </section>;
}
