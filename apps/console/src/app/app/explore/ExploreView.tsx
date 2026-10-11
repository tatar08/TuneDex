'use client';

import dynamic from 'next/dynamic';
import { useEffect, useMemo, useRef, useState } from 'react';
import '@fontsource/ibm-plex-sans-thai/400.css';
import '@fontsource/ibm-plex-sans-thai/500.css';
import '@fontsource/ibm-plex-sans-thai/600.css';
import type { MapListStation, MapStation } from '@/lib/bff';
import { Lang, strings } from '@/lib/i18n';
import { countryName, languageName } from '@/lib/names';
import { appendChannel } from '@/lib/playlist';
import { AppNav } from '../AppNav';
import { PlayerSlot, usePlayer } from '../player/Player';
import { COUNTRY_CODES } from './countries';
import { logoSrc } from './logo';
import { useWebTheme } from '../AppFrame';
import { ExplorerRadioMap } from './ExplorerRadioMap';
import type { GlobePalette } from './WorldGlobe';

const WorldMap = dynamic(() => import('./WorldMap').then((m) => m.WorldMap), {
  ssr: false,
});
const WorldGlobe = dynamic(() => import('./WorldGlobe').then((m) => m.WorldGlobe), { ssr: false });

type View = 'map' | 'globe';
type Look = 'auto' | 'light' | 'dark';
/** How far the station list is pulled up over the map on a phone or a portrait tablet. */
/** How far the phone's station sheet is pulled up: folded to its handle and the count, three stations, half, all. */
type Sheet = 'closed' | 'peek' | 'half' | 'full';
const SHEETS: Sheet[] = ['closed', 'peek', 'half', 'full'];
/** A tap on the handle folds the resting sheet away or brings it back; from higher up it returns to rest. */
const tapSheet = (h: Sheet): Sheet => (h === 'peek' ? 'closed' : 'peek');
const VIEW_KEY = 'tunedeck.web.exploreView';
const LOOK_KEY = 'tunedeck.web.exploreLook';

/** Same colours as the CSS look tokens in globals.css (.explore-app), for the WebGL globe. */
const GLOBE: Record<'light' | 'dark', GlobePalette> = {
  light: {
    ocean: '#eef2f7',
    land: '#ffffff',
    border: '#d5dce5',
    dot: '#fb9f23',
    dotOn: '#111827',
    glow: '#c9d6e6',
  },
  dark: {
    ocean: '#0e1820',
    land: '#22333a',
    border: '#3a525b',
    dot: '#fb9f23',
    dotOn: '#f4f6f8',
    glow: '#2c4752',
  },
};

const remembered = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const remember = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* not remembered, still switched */
  }
};

/**
 * Community radio on a flat map or a 3D globe: search and genre chips on top, the map as the main area, the station
 * list beside it (below it on a phone) and the player along the bottom. Light follows TuneIn's explorer, dark follows
 * Radio Garden's night globe (Tar picked both, Codex Consult/009 merged them). Picking a dot never starts playback.
 */
export function ExploreView({ lang, csrfToken }: { lang: Lang; csrfToken: string }) {
  const t = strings(lang);
  const reference = useWebTheme() === 'explorer';
  const [view, setView] = useState<View>('map');
  const [look, setLook] = useState<Look>('auto');
  const [systemDark, setSystemDark] = useState(false);
  const [country, setCountry] = useState('');
  const [countryText, setCountryText] = useState('');
  const [home, setHome] = useState<string | null>(null);
  const [stations, setStations] = useState<MapStation[] | null>(null);
  const [unmapped, setUnmapped] = useState<MapListStation[]>([]);
  const [failed, setFailed] = useState(false);
  const [selected, setSelected] = useState<MapListStation | null>(null);
  const [group, setGroup] = useState<Set<string> | null>(null);
  const { now, play: setNow } = usePlayer();
  const [filter, setFilter] = useState('');
  const [genre, setGenre] = useState('');
  const [note, setNote] = useState('');
  const [noGlobe, setNoGlobe] = useState(false);
  const [sheet, setSheet] = useState<Sheet>('peek');
  const drag = useRef<number | null>(null);

  useEffect(() => {
    document.documentElement.lang = lang;
    // The viewer's own country joins the world view: Thai for a Thai page, else the browser's region.
    const region = lang === 'th' ? 'TH' : /-([A-Z]{2})$/.exec(navigator.language ?? '')?.[1];
    if (region && COUNTRY_CODES.includes(region)) setHome(region);
    if (remembered(VIEW_KEY) === 'globe') setView('globe');
    const l = remembered(LOOK_KEY);
    if (l === 'light' || l === 'dark') setLook(l);
    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!media) return;
    setSystemDark(media.matches);
    const change = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, [lang]);

  useEffect(() => {
    let live = true;
    setStations(null);
    setUnmapped([]);
    setFailed(false);
    setSelected(null);
    setGroup(null);
    setGenre('');
    fetch(`/bff/directory/map${country ? `?country=${country}` : home ? `?home=${home}` : ''}`, {
      headers: { accept: 'application/json' },
    })
      .then(async (res) => {
        if (res.status === 401) return window.location.assign('/login?returnTo=/app/explore');
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as {
          stations: MapStation[];
          unmapped?: MapListStation[];
        };
        if (!live) return;
        setStations(body.stations);
        setUnmapped(body.unmapped ?? []);
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [country, home]);

  function chooseView(v: View) {
    setView(v);
    setNoGlobe(false);
    remember(VIEW_KEY, v);
  }
  function chooseLook(l: Look) {
    setLook(l);
    remember(LOOK_KEY, l);
  }

  const countries = useMemo(
    () => COUNTRY_CODES.map((c) => ({ code: c, name: countryName(c, lang) })).sort((a, b) => a.name.localeCompare(b.name, lang)),
    [lang],
  );
  // A typed country matches its name in the page language, its English name or its two-letter code.
  const countryByText = useMemo(() => {
    const m = new Map<string, string>();
    for (const { code, name } of countries) for (const k of [name, countryName(code, 'en'), code]) m.set(k.toLocaleLowerCase(), code);
    return m;
  }, [countries]);
  function typeCountry(text: string) {
    setCountryText(text);
    const key = text
      .trim()
      .replace(/^ประเทศ\s*/, '')
      .toLocaleLowerCase();
    const code = key ? countryByText.get(key) : '';
    if (code !== undefined && code !== country) setCountry(code);
  }

  // The six most common genres among the loaded stations become the chips.
  const genres = useMemo(() => {
    const count = new Map<string, number>();
    for (const s of [...(stations ?? []), ...unmapped]) for (const g of new Set(s.genres.map((x) => x.toLowerCase()))) count.set(g, (count.get(g) ?? 0) + 1);
    return [...count.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 6)
      .map(([g]) => g);
  }, [stations, unmapped]);
  const q = filter.trim().toLowerCase();
  const match = (s: MapListStation) => (!q || s.name.toLowerCase().includes(q)) && (!genre || s.genres.some((g) => g.toLowerCase() === genre));
  const shown = useMemo(() => (stations ?? []).filter(match), [stations, q, genre]);
  const list = group ? shown.filter((s) => group.has(s.id)) : shown;
  const others = group ? [] : unmapped.filter(match);
  const dark = look === 'dark' || (look === 'auto' && systemDark);

  const line = (s: MapListStation) =>
    [
      s.country && countryName(s.country, lang),
      s.language && (/^[a-z]{2,3}$/.test(s.language) ? languageName(s.language, lang) : s.language.replace(/^./, (c) => c.toUpperCase())),
      s.genres.slice(0, 2).join(', '),
      s.codec.toUpperCase(),
    ]
      .filter(Boolean)
      .join(' · ');
  const play = (s: MapListStation) => setNow({ name: s.name, url: s.streamUrl, hls: s.codec === 'hls', logo: logoSrc(s) });
  const add = (s: MapListStation) =>
    setNote(
      appendChannel({
        id: crypto.randomUUID(),
        name: s.name,
        url: s.streamUrl,
        group: s.country ? countryName(s.country, lang) : undefined,
        hls: s.codec === 'hls',
      })
        ? t.exploreAdded(s.name)
        : t.exploreAlready,
    );
  const select = (s: MapListStation) => {
    setSelected(s);
    setNote('');
    // A folded sheet opens again, so the picked station and its buttons can be seen.
    setSheet((h) => (h === 'closed' ? 'peek' : h));
  };
  const step = (by: number) => setSheet((h) => SHEETS[Math.min(SHEETS.length - 1, Math.max(0, SHEETS.indexOf(h) + by))]);
  const looks: Look[] = ['auto', 'light', 'dark'];
  const lookName = { auto: t.exploreLookAuto, light: t.exploreLookLight, dark: t.exploreLookDark };
  const globe = view === 'globe' && !noGlobe;

  const row = (s: MapListStation, testId: string) => {
    const playingThis = now?.url === s.streamUrl;
    return (
      <li key={s.id} data-testid={testId} className={selected?.id === s.id ? 'on' : undefined}>
        {/* eslint-disable-next-line @next/next/no-img-element -- small same-origin logo */}
        <img className="explore-logo" src={logoSrc(s)} alt="" width={36} height={36} loading="lazy" decoding="async" />
        <button type="button" className="explore-row" aria-current={selected?.id === s.id ? 'true' : undefined} onClick={() => select(s)}>
          <span className="explore-name">{s.name}</span>
          <span className="explore-meta">{line(s)}</span>
        </button>
        <button
          type="button"
          className={playingThis ? 'explore-play on' : 'explore-play'}
          aria-pressed={playingThis}
          aria-label={t.playerPlay(s.name)}
          onClick={() => {
            select(s);
            play(s);
          }}
        >
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <path d="M8 5.5v13l10.5-6.5z" fill="currentColor" />
          </svg>
        </button>
      </li>
    );
  };

  const segmented = <T extends string>(label: string, value: T, options: [T, string][], pick: (v: T) => void) => (
    <div className="explore-seg" role="group" aria-label={label}>
      {options.map(([v, text]) => (
        <button key={v} type="button" className={value === v ? 'on' : ''} aria-pressed={value === v} onClick={() => pick(v)}>
          {text}
        </button>
      ))}
    </div>
  );

  if (reference) return <ExplorerRadioMap country={country} setCountry={code=>{setCountry(code);setCountryText(code?countryName(code,lang):'')}} lang={lang} stations={shown} unmapped={others} selected={selected} loading={stations===null&&!failed} failed={failed} filter={filter} setFilter={setFilter} genre={genre} setGenre={setGenre} genres={genres} select={select} play={play} add={add} note={note} onGroup={members=>setGroup(new Set(members.map(s=>s.id)))} group={group} clearGroup={()=>setGroup(null)}/>;
  return (
    <main className="shell wide explore-shell">
      <AppNav lang={lang} current="/app/explore" csrfToken={csrfToken} />
      <h1>{t.exploreTitle}</h1>
      <p className="lede">{t.exploreLede}</p>

      <section className="explore-app" data-look={look} aria-label={t.exploreTitle}>
        <div className="explore-bar">
          <span className="explore-search">
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" strokeWidth="2" />
              <path d="M16 16l4.5 4.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            <input
              id="explore-search"
              type="search"
              aria-label={t.exploreSearch}
              placeholder={t.exploreSearch}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </span>
          <span className="explore-country">
            <label className="sr-only" htmlFor="explore-country">
              {t.exploreCountry}
            </label>
            <input
              id="explore-country"
              className="explore-select"
              list="explore-countries"
              autoComplete="off"
              placeholder={t.exploreCountryHint}
              value={countryText}
              onChange={(e) => typeCountry(e.target.value)}
            />
            <datalist id="explore-countries">
              {countries.map((c) => (
                <option key={c.code} value={c.name} />
              ))}
            </datalist>
            {country && (
              <button type="button" className="explore-clear" aria-label={t.exploreWorld} title={t.exploreWorld} onClick={() => typeCountry('')}>
                <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                  <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
              </button>
            )}
          </span>
          {segmented(
            t.exploreViewLabel,
            view,
            [
              ['map', t.exploreMap],
              ['globe', t.exploreGlobe],
            ],
            chooseView,
          )}
          {segmented(
            t.exploreLook,
            look,
            [
              ['auto', t.exploreLookAuto],
              ['light', t.exploreLookLight],
              ['dark', t.exploreLookDark],
            ],
            chooseLook,
          )}
        </div>

        {genres.length > 0 && (
          <div className="explore-chips" role="group" aria-label={t.exploreGenres}>
            {['', ...genres].map((g) => (
              <button key={g || 'all'} type="button" className={genre === g ? 'on' : ''} aria-pressed={genre === g} onClick={() => setGenre(g)}>
                {g ? g.replace(/^./, (c) => c.toUpperCase()) : t.exploreAllGenres}
              </button>
            ))}
          </div>
        )}

        <div className="explore-body" data-sheet={sheet} data-playing={now ? 'true' : undefined}>
          <div className="explore-stage">
            {globe ? (
              <WorldGlobe
                stations={shown}
                selected={selected?.id ?? null}
                onSelect={select}
                onFail={() => setNoGlobe(true)}
                fit={!!country}
                palette={GLOBE[dark ? 'dark' : 'light']}
              />
            ) : (
              <WorldMap
                stations={shown}
                selected={selected?.id ?? null}
                onSelect={select}
                onGroup={(members) => setGroup(new Set(members.map((s) => s.id)))}
                fit={!!country}
                labels={{
                  zoomIn: t.exploreZoomIn,
                  zoomOut: t.exploreZoomOut,
                  group: t.exploreGroup,
                }}
              />
            )}
            {stations === null && !failed && <p className="explore-overlay">{t.exploreLoading}</p>}
            {noGlobe && (
              <p role="alert" className="explore-overlay">
                {t.exploreNoGlobe}
              </p>
            )}
            {/* Phone and portrait tablet: the two switches shrink to round buttons on the map. */}
            <div className="explore-tools">
              <button
                type="button"
                aria-label={t.exploreSwitchView(view === 'globe' ? t.exploreMap : t.exploreGlobe)}
                title={t.exploreSwitchView(view === 'globe' ? t.exploreMap : t.exploreGlobe)}
                onClick={() => chooseView(view === 'globe' ? 'map' : 'globe')}
              >
                {view === 'globe' ? (
                  <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
                    <path d="M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2zM9 4v14M15 6v14" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8">
                    <circle cx="12" cy="12" r="9" />
                    <path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18" />
                  </svg>
                )}
              </button>
              <button
                type="button"
                aria-label={t.exploreSwitchLook(lookName[look])}
                title={t.exploreSwitchLook(lookName[look])}
                onClick={() => chooseLook(looks[(looks.indexOf(look) + 1) % looks.length])}
              >
                <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <circle cx="12" cy="12" r="8" />
                  {look === 'auto' ? <path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor" /> : look === 'dark' ? <circle cx="12" cy="12" r="8" fill="currentColor" /> : null}
                </svg>
              </button>
            </div>
          </div>

          <aside className="explore-panel" aria-labelledby="explore-list">
            <button
              type="button"
              className="explore-handle"
              aria-label={t.exploreSheet}
              aria-expanded={sheet !== 'closed'}
              onPointerDown={(e) => {
                drag.current = e.clientY;
                e.currentTarget.setPointerCapture?.(e.pointerId);
              }}
              onPointerUp={(e) => {
                const from = drag.current;
                drag.current = null;
                if (from === null) return;
                const dy = e.clientY - from;
                if (Math.abs(dy) > 30) step(dy < 0 ? 1 : -1);
                else setSheet(tapSheet);
              }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowUp') step(1);
                if (e.key === 'ArrowDown') step(-1);
              }}
              onClick={(e) => {
                // Keyboard Enter/Space arrive as a click with no pointer gesture before it.
                if (e.detail === 0) setSheet(tapSheet);
              }}
            >
              <span aria-hidden="true" />
            </button>
            {selected && (
              <section className="explore-pick" aria-label={selected.name} data-testid="explore-pick">
                <span className="explore-pick-head">
                  {/* eslint-disable-next-line @next/next/no-img-element -- small same-origin logo */}
                  <img className="explore-logo big" src={logoSrc(selected)} alt="" width={56} height={56} decoding="async" />
                  <span className="explore-pick-text">
                    <span className="explore-name">{selected.name}</span>
                    <span className="explore-meta">{line(selected)}</span>
                  </span>
                </span>
                <span className="explore-pick-actions">
                  <button type="button" className="explore-btn primary" aria-label={t.explorePlay} onClick={() => play(selected)}>
                    <svg className="sheet-only" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                      <path d="M8 5.5v13l10.5-6.5z" fill="currentColor" />
                    </svg>
                    <span className="wide-only">{t.explorePlay}</span>
                  </button>
                  <button type="button" className="explore-btn" aria-label={t.exploreAdd} onClick={() => add(selected)}>
                    <span className="wide-only">{t.exploreAdd}</span>
                    <span className="sheet-only" aria-hidden="true">
                      {t.exploreAddShort}
                    </span>
                  </button>
                </span>
                {note && (
                  <p role="status" className="explore-meta">
                    {note}
                  </p>
                )}
              </section>
            )}

            <h2 id="explore-list">{stations ? t.exploreCount(stations.length) : t.exploreStations}</h2>
            {failed && (
              <p role="alert" className="explore-meta">
                {t.exploreError}
              </p>
            )}
            {group && (
              <p className="explore-group">
                <span>{t.exploreGroupShown(list.length)}</span>
                <button type="button" className="explore-btn" onClick={() => setGroup(null)}>
                  {t.exploreShowAll}
                </button>
              </p>
            )}
            {stations && stations.length === 0 && unmapped.length === 0 && <p className="explore-meta">{t.exploreNone}</p>}
            {stations && (stations.length > 0 || unmapped.length > 0) && list.length === 0 && others.length === 0 && (
              <p className="explore-meta">{t.exploreNoMatch}</p>
            )}
            {list.length > 0 && <ul className="explore-list">{list.slice(0, 100).map((s) => row(s, 'explore-station'))}</ul>}
            {others.length > 0 && (
              <>
                <h3 className="explore-sub">{t.exploreUnmapped(others.length)}</h3>
                <ul className="explore-list">{others.slice(0, 200).map((s) => row(s, 'explore-unmapped'))}</ul>
              </>
            )}
            <p className="explore-source">{t.exploreSource}</p>
          </aside>

          {/* A bar under the map and list on a wide screen; on a phone a capsule floating on the map, above the sheet. */}
          <PlayerSlot className="explore-player" />
        </div>
      </section>
    </main>
  );
}
