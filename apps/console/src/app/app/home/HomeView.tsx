'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { CatalogStation, Favorite } from '@/lib/bff';
import { Lang, strings } from '@/lib/i18n';
import { countryName } from '@/lib/names';
import { AppNav } from '../AppNav';
import { usePlayer } from '../player/Player';
import type { NowPlaying } from '../radio/MediaPlayer';

type Tab = 'favorites' | 'curated' | 'recent';
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
 * favourites, the curated catalog, or what this browser played last. Opens on favourites when there are some,
 * else on the catalog, so there is always something to press. A press on Play is the only thing that starts sound.
 */
export function HomeView({ lang, csrfToken, favorites, stations }: { lang: Lang; csrfToken: string; favorites: Favorite[] | null; stations: CatalogStation[] | null }) {
  const t = strings(lang);
  const { now, play, recent } = usePlayer();
  const meta = (s: CatalogStation) => [countryName(s.country, lang), s.genres.slice(0, 2).join(', ')].filter(Boolean).join(' · ');
  const card = (s: CatalogStation): Card => ({ key: s.id, name: s.name, url: s.streamUrl, hls: s.codec === 'hls', meta: meta(s) });
  const byId = new Map((stations ?? []).map((s) => [s.id, s]));
  const lists: Record<Tab, Card[]> = {
    favorites: [...(favorites ?? [])].sort((a, b) => a.order - b.order).flatMap((f) => (byId.has(f.stationId) ? [card(byId.get(f.stationId)!)] : [])),
    curated: (stations ?? []).map(card),
    recent: recent.map((r) => ({ ...r, key: r.url, meta: t.homeRecentMeta })),
  };
  const [tab, setTab] = useState<Tab>(lists.favorites.length ? 'favorites' : 'curated');
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);
  const tabs: [Tab, string][] = [
    ['favorites', t.radioFavorites],
    ['curated', t.homeCurated],
    ['recent', t.homeRecent],
  ];
  const shown = lists[tab];
  const empty = tab === 'favorites' ? (favorites === null ? t.radioLoadError : t.homeFavoritesNone) : tab === 'curated' ? (stations === null ? t.radioLoadError : t.radioCatalogNone) : t.homeRecentNone;

  return (
    <main className="shell wide home-shell">
      <AppNav lang={lang} current="/app/home" csrfToken={csrfToken} />
      <h1>{t.homeTitle}</h1>
      <p className="lede">{t.homeLede}</p>
      <div className="wall-tabs" role="tablist" aria-label={t.homeTitle}>
        {tabs.map(([id, text]) => (
          <button key={id} type="button" role="tab" id={`wall-tab-${id}`} aria-selected={tab === id} aria-controls="wall" onClick={() => setTab(id)}>
            {text}
            <span>{lists[id].length}</span>
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
        {shown.length === 0 ? (
          <p className="status">{empty}</p>
        ) : (
          <ul className="wall">
            {shown.map((c) => {
              const on = now?.url === c.url;
              const mark = initials(c.name);
              return (
                <li key={c.key} className={on ? 'on' : undefined} data-testid="wall-station">
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
                  <span className="wall-meta">{on ? t.playerPlaying : c.meta}</span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </main>
  );
}
