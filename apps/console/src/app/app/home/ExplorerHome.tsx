'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Lang, strings } from '@/lib/i18n';
import { usePlayer } from '../player/Player';
import type { Card } from './HomeView';

/** Browsing the feed never starts audio: only its explicit Play uses the shared player. */
export function ExplorerHome({ lang, items, favorites, recent, countryControl, empty }: { lang: Lang; items: Card[]; favorites: Card[]; recent: Card[]; countryControl: React.ReactNode; empty: string }) {
  const t = strings(lang);
  const { now, status, play } = usePlayer();
  const [source, setSource] = useState<'all'|'favorites'|'recent'>('all');
  const [query, setQuery] = useState('');
  const [genre, setGenre] = useState('');
  const [message, setMessage] = useState('');
  const feed = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(0);
  const list = source === 'favorites' ? favorites : source === 'recent' ? recent : items;
  const genres = useMemo(() => [...new Set(list.flatMap(c => c.genres ?? []))].sort(), [list]);
  const shown = list.filter(c => (!genre || c.genres?.includes(genre)) && `${c.name} ${c.meta} ${c.language ?? ''}`.toLocaleLowerCase(lang).includes(query.toLocaleLowerCase(lang)));
  const identity = shown.map(c => c.key).join('|');
  useEffect(() => {
    setIndex(0);
    feed.current?.scrollTo({ top: 0 });
    const root = feed.current;
    if (!root) return;
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) if (entry.isIntersecting) setIndex(Number((entry.target as HTMLElement).dataset.index));
    }, { root, threshold: .6 });
    root.querySelectorAll('article').forEach(el => observer.observe(el));
    return () => observer.disconnect();
  }, [identity]);
  const step = (direction: number) => {
    const next = Math.min(Math.max(index + direction, 0), shown.length - 1);
    feed.current?.querySelectorAll('article')[next]?.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  };
  const copy = async (card: Card) => {
    try {
      await navigator.clipboard.writeText(card.url);
      setMessage(lang === 'th' ? 'คัดลอกลิงก์สตรีมแล้ว' : 'Stream link copied');
    } catch { setMessage(lang === 'th' ? 'คัดลอกไม่ได้ กรุณาเปิดผ่าน HTTPS และอนุญาตคลิปบอร์ด' : 'Cannot copy. Use HTTPS and allow clipboard access.'); }
  };
  return <section className="explorer-home">
    <header className="explorer-heading"><div><h1>Explorer</h1><p>{lang === 'th' ? 'ค้นพบสถานี เลื่อนเลือก แล้วกดเล่นเพื่อฟัง' : 'Discover stations. Browse, then press Play to listen.'}</p></div><Link href="/app/explore" prefetch={false}>{t.homeExplore}</Link></header>
    <div className="explorer-tools">
      <label>{t.exploreSearch}<input type="search" value={query} onChange={e => setQuery(e.target.value)} /></label>
      <label>{lang === 'th' ? 'แนวเพลง' : 'Genre'}<select value={genre} onChange={e => setGenre(e.target.value)}><option value="">{lang === 'th' ? 'ทั้งหมด' : 'All'}</option>{genres.map(g => <option key={g}>{g}</option>)}</select></label>
      {countryControl}
    </div>
    <div className="explorer-sources" role="group" aria-label={lang === 'th' ? 'รายการสถานี' : 'Station collection'}>
      {([['all', lang === 'th' ? 'ค้นพบ' : 'Discover'], ['favorites', t.radioFavorites], ['recent', t.homeRecent]] as const).map(([key, label]) => <button key={key} type="button" aria-pressed={source === key} onClick={() => { setSource(key); setGenre(''); }}>{label}</button>)}
      <Link href="/app/radio" prefetch={false}>{t.homeManage}</Link>
    </div>
    <div className="explorer-stage">
      <div className="explorer-feed" ref={feed} tabIndex={0} aria-label={lang === 'th' ? 'ฟีดสถานี' : 'Station feed'} onKeyDown={e => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); step(e.key === 'ArrowDown' ? 1 : -1); }
      }}>
        {!shown.length && <p role="status">{query || genre ? t.exploreNone : source === 'favorites' ? t.homeFavoritesNone : source === 'recent' ? t.homeRecentNone : empty}</p>}
        {shown.map((c, i) => {
          const active = now?.url === c.url;
          const playing = active && status === 'playing';
          const initials = c.name.trim().split(/\s+/).slice(0, 2).map(word => word[0]).join('').toUpperCase();
          return <article key={c.key} data-index={i} className={playing ? 'is-playing' : ''}>
            <div className="explorer-card" style={{ background: ['#9f1239', '#115e59', '#3730a3', '#075985'][i % 4] }}>
              <svg viewBox="0 0 400 400" className="explorer-rings" aria-hidden="true">{[65,105,145,185].map(r => <circle key={r} cx="200" cy="200" r={r} />)}</svg>
              <span className="explorer-initials" aria-hidden="true">{initials}</span>
              <span className="explorer-state" role="status">{active ? status === 'playing' ? t.playerPlaying : status === 'failed' ? t.playerFailed : t.playerConnecting : lang === 'th' ? 'พร้อมฟัง' : 'Ready to listen'}</span>
              <button className="explorer-play" type="button" aria-label={t.playerPlay(c.name)} aria-pressed={active} onClick={() => play(c)}><span aria-hidden="true">▶</span></button>
              <div className="explorer-caption"><h2>{c.name}</h2><p>{c.meta}</p>{c.language && <span>{c.language}</span>}</div>
            </div>
            <aside className="explorer-actions" aria-label={c.name}>
              <span className="explorer-avatar" aria-hidden="true">{initials}</span>
              <button type="button" onClick={() => void copy(c)} aria-label={lang === 'th' ? `คัดลอกลิงก์ ${c.name}` : `Copy link ${c.name}`}>↗<small>{lang === 'th' ? 'คัดลอก' : 'Copy'}</small></button>
              <Link href="/app/radio" prefetch={false}>♡<small>{t.homeManage}</small></Link>
              <span className="explorer-disc" aria-hidden="true">♫</span>
            </aside>
          </article>;
        })}
      </div>
      <div className="explorer-steppers"><button type="button" onClick={() => step(-1)} disabled={!shown.length || index === 0} aria-label={lang === 'th' ? 'สถานีก่อนหน้า' : 'Previous station'}>↑</button><span>{shown.length ? index + 1 : 0} / {shown.length}</span><button type="button" onClick={() => step(1)} disabled={!shown.length || index === shown.length - 1} aria-label={lang === 'th' ? 'สถานีถัดไป' : 'Next station'}>↓</button></div>
    </div>
    <p className="status" role="status">{message}</p>
  </section>;
}
