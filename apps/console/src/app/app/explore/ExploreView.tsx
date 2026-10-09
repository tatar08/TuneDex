'use client';

import dynamic from 'next/dynamic';
import { useEffect, useMemo, useState } from 'react';
import type { MapListStation, MapStation } from '@/lib/bff';
import { Lang, strings } from '@/lib/i18n';
import { countryName, languageName } from '@/lib/names';
import { appendChannel } from '@/lib/playlist';
import { AppNav } from '../AppNav';
import { MediaPlayer, NowPlaying } from '../radio/MediaPlayer';
import { COUNTRY_CODES } from './countries';

const WorldMap = dynamic(() => import('./WorldMap').then((m) => m.WorldMap), { ssr: false });
const WorldGlobe = dynamic(() => import('./WorldGlobe').then((m) => m.WorldGlobe), { ssr: false });

type View = 'map' | 'globe';
const VIEW_KEY = 'tunedeck.web.exploreView';

export function ExploreView({ lang, csrfToken }: { lang: Lang; csrfToken: string }) {
  const t = strings(lang);
  const [view, setView] = useState<View>('map');
  const [country, setCountry] = useState('');
  const [stations, setStations] = useState<MapStation[] | null>(null);
  const [unmapped, setUnmapped] = useState<MapListStation[]>([]);
  const [failed, setFailed] = useState(false);
  const [selected, setSelected] = useState<MapListStation | null>(null);
  const [now, setNow] = useState<NowPlaying | null>(null);
  const [filter, setFilter] = useState('');
  const [note, setNote] = useState('');
  const [noGlobe, setNoGlobe] = useState(false);

  useEffect(() => {
    document.documentElement.lang = lang;
    try {
      if (localStorage.getItem(VIEW_KEY) === 'globe') setView('globe');
    } catch {
      /* the default view is fine */
    }
  }, [lang]);

  useEffect(() => {
    let live = true;
    setStations(null);
    setUnmapped([]);
    setFailed(false);
    setSelected(null);
    fetch(`/bff/directory/map${country ? `?country=${country}` : ''}`, { headers: { accept: 'application/json' } })
      .then(async (res) => {
        if (res.status === 401) return window.location.assign('/login?returnTo=/app/explore');
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as { stations: MapStation[]; unmapped?: MapListStation[] };
        if (!live) return;
        setStations(body.stations);
        setUnmapped(body.unmapped ?? []);
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [country]);

  function choose(v: View) {
    setView(v);
    setNoGlobe(false);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* not remembered, still switched */
    }
  }

  const countries = useMemo(() => COUNTRY_CODES.map((c) => ({ code: c, name: countryName(c, lang) })).sort((a, b) => a.name.localeCompare(b.name, lang)), [lang]);
  const q = filter.trim().toLowerCase();
  const match = (s: MapListStation) => !q || s.name.toLowerCase().includes(q);
  const list = (stations ?? []).filter(match);
  const others = unmapped.filter(match);
  const line = (s: MapListStation) =>
    [s.country && countryName(s.country, lang), s.language && (/^[a-z]{2,3}$/.test(s.language) ? languageName(s.language, lang) : s.language.replace(/^./, (c) => c.toUpperCase())), s.genres.slice(0, 2).join(', '), s.codec.toUpperCase()].filter(Boolean).join(' · ');
  const play = (s: MapListStation) => setNow({ name: s.name, url: s.streamUrl, hls: s.codec === 'hls' });
  const add = (s: MapListStation) =>
    setNote(appendChannel({ id: crypto.randomUUID(), name: s.name, url: s.streamUrl, group: s.country ? countryName(s.country, lang) : undefined, hls: s.codec === 'hls' }) ? t.exploreAdded(s.name) : t.exploreAlready);
  const select = (s: MapListStation) => {
    setSelected(s);
    setNote('');
  };
  const globe = view === 'globe' && !noGlobe;
  const row = (s: MapListStation, testId: string) => (
    <li key={s.id} data-testid={testId}>
      <span className="device-name">{s.name}</span>
      <span className="radio-actions">
        <button
          type="button"
          className="btn secondary small"
          aria-pressed={now?.url === s.streamUrl}
          aria-label={t.playerPlay(s.name)}
          onClick={() => {
            select(s);
            play(s);
          }}
        >
          ▶
        </button>
      </span>
      <span className="status">{line(s)}</span>
    </li>
  );

  return (
    <main className="shell wide">
      <AppNav lang={lang} current="/app/explore" csrfToken={csrfToken} />
      <h1>{t.exploreTitle}</h1>
      <p className="lede">{t.exploreLede}</p>

      {now && <MediaPlayer lang={lang} item={now} onStop={() => setNow(null)} />}

      <div className="explore-tools">
        <div className="segmented" role="group" aria-label={t.exploreViewLabel}>
          <button type="button" className={view === 'map' ? 'on' : ''} aria-pressed={view === 'map'} onClick={() => choose('map')}>
            {t.exploreMap}
          </button>
          <button type="button" className={view === 'globe' ? 'on' : ''} aria-pressed={view === 'globe'} onClick={() => choose('globe')}>
            {t.exploreGlobe}
          </button>
        </div>
        <label className="sr-only" htmlFor="explore-country">
          {t.exploreCountry}
        </label>
        <select id="explore-country" value={country} onChange={(e) => setCountry(e.target.value)}>
          <option value="">{t.exploreWorld}</option>
          {countries.map((c) => (
            <option key={c.code} value={c.code}>
              {c.name}
            </option>
          ))}
        </select>
      </div>
      {noGlobe && (
        <p role="alert" className="status">
          {t.exploreNoGlobe}
        </p>
      )}

      <div className="explore-stage">
        {globe ? (
          <WorldGlobe stations={stations ?? []} selected={selected?.id ?? null} onSelect={select} onFail={() => setNoGlobe(true)} fit={!!country} />
        ) : (
          <WorldMap stations={stations ?? []} selected={selected?.id ?? null} onSelect={select} fit={!!country} />
        )}
        {stations === null && !failed && <p className="explore-overlay status">{t.exploreLoading}</p>}
      </div>
      {failed && (
        <p role="alert" className="status">
          {t.exploreError}
        </p>
      )}

      {selected && (
        <section className="player explore-pick" aria-label={selected.name} data-testid="explore-pick">
          <div className="player-head">
            <span>
              <span className="device-name">{selected.name}</span>
              <br />
              <span className="status">{line(selected)}</span>
            </span>
            <span className="radio-actions">
              <button type="button" className="btn small" onClick={() => play(selected)}>
                ▶ {t.explorePlay}
              </button>
              <button type="button" className="btn secondary small" onClick={() => add(selected)}>
                {t.exploreAdd}
              </button>
            </span>
          </div>
          {note && (
            <p role="status" className="status">
              {note}
            </p>
          )}
        </section>
      )}

      <section className="device" aria-labelledby="explore-list">
        <h2 id="explore-list">{stations ? t.exploreCount(stations.length) : t.exploreStations}</h2>
        {stations && stations.length === 0 && others.length === 0 && <p className="status">{t.exploreNone}</p>}
        {stations && stations.length > 0 && (
          <>
            <input className="explore-search" type="search" aria-label={t.exploreSearch} placeholder={t.exploreSearch} value={filter} onChange={(e) => setFilter(e.target.value)} />
            <ul className="devices radio-list">
              {list.slice(0, 100).map((s) => row(s, 'explore-station'))}
            </ul>
          </>
        )}
        {others.length > 0 && (
          <>
            <h3 className="explore-sub">{t.exploreUnmapped(others.length)}</h3>
            <ul className="devices radio-list">{others.slice(0, 200).map((s) => row(s, 'explore-unmapped'))}</ul>
          </>
        )}
        <p className="status">{t.exploreSource}</p>
      </section>
    </main>
  );
}
