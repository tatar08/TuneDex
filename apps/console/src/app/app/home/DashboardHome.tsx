'use client';
import { useState } from 'react';
import Link from 'next/link';
import { strings, Lang } from '@/lib/i18n';
import type { Card } from './HomeView';
import { usePlayer } from '../player/Player';
import { Presets } from './Presets';
export function DashboardHome({ lang, items, favorites, headUnit }: { lang: Lang; items: Card[]; favorites: number; headUnit: boolean }) {
  const t = strings(lang), { now, play, recent } = usePlayer();
  const [selected, setSelected] = useState<string | null>(null);
  const index = Math.max(0, items.findIndex(c => c.key === selected));
  const item = items[index] ?? null;
  const move = (delta: number) => { if (items.length) setSelected(items[Math.max(0, Math.min(items.length - 1, index + delta))].key); };
  return <div className={headUnit ? 'dashboard-home head-unit-home' : 'dashboard-home cockpit-home'}>
    <header><h1>{t.homeTitle}</h1><Link href="/app/explore" prefetch={false}>{t.homeExplore}</Link></header>
    <div className="dashboard-bento">
      <section className="station-focus" aria-label={t.stationSelected}>
        <span className="status">{t.stationSelected}</span><h2>{item?.name ?? t.listenChoose}</h2><p>{item?.meta}</p>
        <p className="status">{t.stationPosition(items.length ? index + 1 : 0, items.length)}</p>
        {item && <button className="btn" type="button" onClick={() => play(item)} aria-label={t.playerPlay(item.name)}>{t.playerPlay(item.name)}</button>}
        <p className="status">{now ? t.playerNow(now.name) : t.listenChoose}</p>
      </section>
      {!headUnit && <section className="dashboard-counts"><h2>{t.radioFavorites}</h2><strong>{favorites}</strong><h2>{t.homeRecent}</h2><strong>{recent.length}</strong></section>}
      <section className="tuning-stations" aria-label={t.stationSelected}>
        <div className="tuning-arrows"><button type="button" disabled={index===0 || !items.length} onClick={()=>move(-1)}>{t.stationPrevious}</button><button type="button" disabled={index>=items.length-1} onClick={()=>move(1)}>{t.stationNext}</button></div>
        <ol>{items.map((s,i)=><li key={s.key}><button type="button" aria-pressed={item?.key===s.key} onClick={()=>setSelected(s.key)}>{i+1} · {s.name}</button></li>)}</ol>
      </section>
    </div>
    <Presets lang={lang} candidate={item} />
  </div>;
}
