'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CatalogStation, Favorite, MapListStation } from '@/lib/bff';
import { Lang, strings } from '@/lib/i18n';
import { countryName } from '@/lib/names';
import { CHANNELS_KEY, readChannels } from '@/lib/playlist';
import { useWebTheme } from '../AppFrame';
import { AppNav } from '../AppNav';
import { COUNTRY_CODES } from '../explore/countries';
import { logoSrc } from '../explore/logo';
import { useDesktop } from '../desktop';
import { ListeningPanel } from '../player/ListeningPanel';
import { Presets } from './Presets';
import { usePlayer } from '../player/Player';
import type { NowPlaying } from '../radio/MediaPlayer';

type Tab = 'favorites' | 'popular' | 'links' | 'curated' | 'recent';
const COUNTRY_KEY = 'tunedeck.web.homeCountry';
interface Card extends NowPlaying {
  key: string;
  meta: string;
}

const TILES = ['#0f766e', '#b45309', '#1d4ed8', '#be185d', '#4d7c0f', '#6d28d9'];
/** A station without a logo gets its initials on one of six colours, always the same one for the same name. */
function initials(name: string): { text: string; color: string } {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const text = (words.length > 1 ? words[0][0] + words[1][0] : name.trim().slice(0, 2)).toUpperCase();
  let h = 0;
  for (const c of name) h = (h * 31 + c.codePointAt(0)!) >>> 0;
  return { text, color: TILES[h % TILES.length] };
}

/**
 * Home as a wall of station buttons (the "Personal Radio Wall" Claude and Codex designed together, Consult/013):
 * favourites, a chosen country's most listened community stations, the viewer's own links, the curated catalog, or
 * what this browser played last. Opens on favourites when there are some, else on the country's most listened
 * (the curated catalog if the directory is off), so there is always something to press. The country is the
 * viewer's choice, never a guess presented as "near you". A press on Play is the only thing that starts sound.
 */
export function HomeView({ lang, csrfToken, favorites, stations }: { lang: Lang; csrfToken: string; favorites: Favorite[] | null; stations: CatalogStation[] | null }) {
  const t = strings(lang);
  const theme = useWebTheme();
  const wide = useDesktop();
  const [query, setQuery] = useState('');
  const { now, status, play, recent } = usePlayer();
  const meta = (s: CatalogStation) => [countryName(s.country, lang), s.genres.slice(0, 2).join(', ')].filter(Boolean).join(' · ');
  const card = (s: CatalogStation): Card => ({ key: s.id, name: s.name, url: s.streamUrl, hls: s.codec === 'hls', meta: meta(s) });
  const byId = new Map((stations ?? []).map((s) => [s.id, s]));
  const [country, setCountry] = useState('TH');
  const [popular, setPopular] = useState<MapListStation[] | null | 'failed'>(null);
  const [links, setLinks] = useState<Card[]>([]);
  const favs = [...(favorites ?? [])].sort((a, b) => a.order - b.order).flatMap((f) => (byId.has(f.stationId) ? [card(byId.get(f.stationId)!)] : []));
  const lists: Record<Tab, Card[]> = {
    favorites: favs,
    popular: Array.isArray(popular) ? popular.map((s) => ({ key: s.id, name: s.name, url: s.streamUrl, hls: s.codec === 'hls', logo: logoSrc(s), meta: s.genres.slice(0, 2).join(', ') || countryName(s.country ?? country, lang) })) : [],
    links,
    curated: (stations ?? []).map(card),
    recent: recent.map((r) => ({ ...r, key: r.url, meta: t.homeRecentMeta })),
  };
  const [tab, setTab] = useState<Tab>(favs.length ? 'favorites' : 'popular');
  /** Until the viewer picks a tab, the page may move itself off a tab that turned out to have nothing. */
  const auto = useRef(true);
  const countries = useMemo(() => COUNTRY_CODES.map((c) => ({ code: c, name: countryName(c, lang) })).sort((a, b) => a.name.localeCompare(b.name, lang)), [lang]);

  useEffect(() => {
    document.documentElement.lang = lang;
    try {
      const saved = localStorage.getItem(COUNTRY_KEY);
      const region = saved ?? (lang === 'th' ? 'TH' : /-([A-Z]{2})$/.exec(navigator.language ?? '')?.[1]);
      if (region && COUNTRY_CODES.includes(region)) setCountry(region);
      setLinks(readChannels(localStorage.getItem(CHANNELS_KEY)).map((c) => ({ key: c.id, name: c.name, url: c.url, hls: c.hls, meta: c.group ?? t.homeLinkMeta })));
    } catch {
      /* nothing remembered */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per language
  }, [lang]);

  useEffect(() => {
    let live = true;
    setPopular(null);
    fetch(`/bff/directory/top?country=${country}`, { headers: { accept: 'application/json' } })
      .then(async (res) => {
        if (res.status === 401) return window.location.assign('/login?returnTo=/app/home');
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as { stations: MapListStation[] };
        if (live) setPopular(body.stations);
      })
      .catch(() => {
        if (!live) return;
        setPopular('failed');
        // The directory is off or unreachable: show the curated catalog rather than an error as the first thing.
        if (auto.current) setTab((cur) => (cur === 'popular' ? 'curated' : cur));
      });
    return () => {
      live = false;
    };
  }, [country]);

  const chooseTab = (id: Tab) => {
    auto.current = false;
    setTab(id);
  };
  const chooseCountry = (code: string) => {
    auto.current = false;
    setCountry(code);
    try {
      localStorage.setItem(COUNTRY_KEY, code);
    } catch {
      /* not remembered, still switched */
    }
  };
  const tabs: [Tab, string][] = [
    ['favorites', t.radioFavorites],
    ['popular', t.homePopular],
    ['links', t.homeLinks],
    ['curated', t.homeCurated],
    ['recent', t.homeRecent],
  ];
  const shown = lists[tab];
  const empty =
    tab === 'favorites'
      ? favorites === null ? t.radioLoadError : t.homeFavoritesNone
      : tab === 'popular'
        ? popular === null ? t.exploreLoading : popular === 'failed' ? t.exploreError : t.exploreNone
        : tab === 'links'
          ? t.homeLinksNone
          : tab === 'curated'
            ? stations === null ? t.radioLoadError : t.radioCatalogNone
            : t.homeRecentNone;

  const tile = (c: Card, testId = 'wall-station') => {
    const on = now?.url === c.url;
    const mark = initials(c.name);
    return (
      <li key={c.key} className={on ? 'on' : undefined} data-testid={testId}>
        {c.logo ? (
          // eslint-disable-next-line @next/next/no-img-element -- small same-origin logo
          <img className="wall-logo" src={c.logo} alt="" width={56} height={56} loading="lazy" decoding="async" />
        ) : (
          <span className="wall-logo" style={{ background: mark.color }} aria-hidden="true">
            {mark.text}
          </span>
        )}
        <button type="button" className="wall-play" aria-pressed={on} aria-label={t.playerPlay(c.name)} onClick={() => play({ name: c.name, url: c.url, hls: c.hls, logo: c.logo })}>
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <path d="M8 5.5v13l10.5-6.5z" fill="currentColor" />
          </svg>
        </button>
        <span className="wall-name">{c.name}</span>
        <span className="wall-meta legacy-stream-state">{on ? t.playerPlaying : c.meta}</span>
        {!['classic', 'radio-wall'].includes(theme) && (
          <span className="wall-meta desktop-stream-state">{on ? status === 'failed' ? t.playerFailed : status === 'playing' ? t.playerPlaying : t.playerConnecting : c.meta}</span>
        )}
      </li>
    );
  };

  const countryControl = (id: string) => <div className="wall-country">
    <label htmlFor={id}>{t.homeCountry}</label>
    <select id={id} value={country} onChange={(e) => chooseCountry(e.target.value)}>{countries.map(c => <option key={c.code} value={c.code}>{c.name}</option>)}</select>
    <span className="status">{t.homePopularNote}</span>
  </div>;
  const shelf = (id: Tab) => <section className={`station-shelf shelf-${id}`} aria-labelledby={`shelf-${id}`} key={id}>
    <div className="shelf-heading"><h2 id={`shelf-${id}`}>{tabs.find(([key]) => key === id)![1]}</h2><Link href={id === 'popular' ? '/app/explore' : '/app/radio'} prefetch={false}>{id === 'popular' ? t.homeExplore : t.homeManage}</Link></div>
    {id === 'popular' && countryControl('shelf-country')}
    {lists[id].length ? <ul className="wall shelf-tiles" aria-label={tabs.find(([key]) => key === id)![1]}>{lists[id].map(c => tile(c, 'shelf-station'))}</ul> : <p className="status">{id === 'favorites' ? favorites === null ? t.radioLoadError : t.homeFavoritesNone : id === 'recent' ? t.homeRecentNone : id === 'links' ? t.homeLinksNone : id === 'popular' ? popular === null ? t.exploreLoading : popular === 'failed' ? t.exploreError : t.exploreNone : stations === null ? t.radioLoadError : t.radioCatalogNone}</p>}
  </section>;
  // Up to three distinct stations, drawn from real history, favourites and available catalogs.
  const highlights = [...lists.recent, ...lists.favorites, ...lists.popular, ...lists.curated].filter((c, i, all) => all.findIndex(x => x.url === c.url) === i).slice(0, 3);

  return (
    <main className="shell wide home-shell">
      <AppNav lang={lang} current="/app/home" csrfToken={csrfToken} />
      {wide && ['listen-find', 'country-window'].includes(theme) && <div className="theme-home-intro">
        <h1>{theme === 'country-window' ? t.countryHeading(countryName(country, lang)) : t.findTitle}</h1>
        <label>{t.exploreSearch}<input value={query} onChange={e => setQuery(e.target.value)} type="search" /></label>
        {countryControl('theme-country')}
      </div>}
      {wide && theme === 'stage' && <ListeningPanel stage />}
      <h1>{t.homeTitle}</h1>
      <p className="lede">{t.homeLede}</p>
      <div className="wall-tabs" role="tablist" aria-label={t.homeTitle}>
        {tabs.map(([id, text]) => (
          <button key={id} type="button" role="tab" id={`wall-tab-${id}`} aria-selected={tab === id} aria-controls="wall" onClick={() => chooseTab(id)}>
            {text}
            {(id !== 'popular' || Array.isArray(popular)) && <span>{lists[id].length}</span>}
          </button>
        ))}
        <Link href="/app/radio" prefetch={false} className="wall-link">
          {t.homeManage}
        </Link>
        <Link href="/app/explore" prefetch={false} className="wall-link">
          {t.homeExplore}
        </Link>
      </div>
      <div id="wall" role="tabpanel" aria-labelledby={`wall-tab-${tab}`}>
        {tab === 'popular' && (
          <p className="wall-country">
            <label htmlFor="wall-country">{t.homeCountry}</label>
            <select id="wall-country" value={country} onChange={(e) => chooseCountry(e.target.value)}>
              {countries.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.name}
                </option>
              ))}
            </select>
            <span className="status">{t.homePopularNote}</span>
          </p>
        )}
        {shown.length === 0 ? (
          <p className="status">{empty}</p>
        ) : (
          <ul className="wall">
            {shown.filter(c => !wide || !['listen-find', 'country-window'].includes(theme) || c.name.toLocaleLowerCase(lang).includes(query.toLocaleLowerCase(lang))).map((c) => tile(c))}
          </ul>
        )}
      </div>
      {wide && theme === 'country-window' && <Presets lang={lang} candidate={now ?? highlights[0] ?? null} />}
      {theme === 'preset-wall' && <aside className="preset-discovery" aria-label={t.homeExplore}>
        <h2>{t.homeExplore}</h2>{countryControl('discovery-country')}
        {lists.popular.length ? <ul className="wall discovery-tiles">{lists.popular.slice(0, 3).map(c => tile(c, 'discovery-station'))}</ul> : <p className="status">{popular === null ? t.exploreLoading : popular === 'failed' ? t.exploreError : t.exploreNone}</p>}
        <Link href="/app/explore" prefetch={false}>{t.homeExplore}</Link>
      </aside>}
      {['shelves', 'studio'].includes(theme) && <div className="shelf-home">
        <header className="shelf-intro"><div><h1>{t.homeTitle}</h1><p className="lede">{t.homeLede}</p></div><Link href="/app/explore" prefetch={false}>{t.homeExplore}</Link></header>
        {theme === 'studio' && highlights.length > 0 && <section className="studio-highlights" aria-label={t.homeTitle}><ul className="wall">{highlights.map(c => tile(c, 'studio-station'))}</ul></section>}
        {(['favorites', 'recent', 'popular', 'curated', 'links'] as Tab[]).map(shelf)}
      </div>}
    </main>
  );
}
