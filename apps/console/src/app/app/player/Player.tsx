'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type HlsType from 'hls.js';
import { Lang, strings } from '@/lib/i18n';
import type { NowPlaying } from '../radio/MediaPlayer';

type Status = 'connecting' | 'playing' | 'failed';
interface PlayerApi {
  now: NowPlaying | null;
  status: Status;
  /** Starts this station or link; only ever called from a press on a play button. */
  play: (item: NowPlaying) => void;
  stop: () => void;
  /** What this browser played last, newest first. */
  recent: NowPlaying[];
  lang: Lang;
  /** A page that draws the player itself says so, and the frame's own bar steps aside while that page is open. */
  claim: () => () => void;
}

const Ctx = createContext<PlayerApi | null>(null);
const RECENT_KEY = 'tunedeck.web.recent';
const RECENT_MAX = 12;

export function usePlayer(): PlayerApi {
  const p = useContext(Ctx);
  if (!p) throw new Error('usePlayer outside PlayerProvider');
  return p;
}

/**
 * One player for every account page (Tar 2026-10-11): it lives in the pages' shared layout, so going from one page
 * to another does not stop the sound. The media element never moves; pages and the frame only draw its controls.
 * HLS plays natively in Safari and through hls.js elsewhere (loaded only when needed, no worker, so the CSP needs
 * no blob: workers). A stream that carries a picture shows it in a small screen floating over the page.
 */
export function PlayerProvider({ lang, children }: { lang: Lang; children: React.ReactNode }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [now, setNow] = useState<NowPlaying | null>(null);
  const [status, setStatus] = useState<Status>('connecting');
  const [hasVideo, setHasVideo] = useState(false);
  const [slots, setSlots] = useState(0);
  const [recent, setRecent] = useState<NowPlaying[]>([]);

  useEffect(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
      if (Array.isArray(saved)) setRecent(saved.filter((x): x is NowPlaying => !!x && typeof x.name === 'string' && typeof x.url === 'string' && x.url.startsWith('https://')).slice(0, RECENT_MAX));
    } catch {
      /* nothing remembered */
    }
  }, []);

  useEffect(() => {
    const video = ref.current;
    if (!video || !now) return;
    setHasVideo(false);
    setStatus('connecting');
    let hls: HlsType | null = null;
    let cancelled = false;
    const start = () => void video.play().catch(() => undefined);
    if (now.hls && !video.canPlayType('application/vnd.apple.mpegurl')) {
      void import('hls.js').then(
        ({ default: Hls }) => {
          if (cancelled) return;
          if (!Hls.isSupported()) return setStatus('failed');
          hls = new Hls({ enableWorker: false, lowLatencyMode: false });
          hls.on(Hls.Events.ERROR, (_e, data) => {
            if (data.fatal) setStatus('failed');
          });
          hls.loadSource(now.url);
          hls.attachMedia(video);
          start();
        },
        () => setStatus('failed'),
      );
    } else {
      video.src = now.url;
      start();
    }
    return () => {
      cancelled = true;
      hls?.destroy();
      video.pause();
      video.removeAttribute('src');
      video.load();
    };
  }, [now]);

  const play = useCallback((item: NowPlaying) => {
    setNow((cur) => (cur && cur.url === item.url ? cur : item));
    setRecent((list) => {
      const next = [item, ...list.filter((x) => x.url !== item.url)].slice(0, RECENT_MAX);
      try {
        localStorage.setItem(RECENT_KEY, JSON.stringify(next));
      } catch {
        /* not remembered, still played */
      }
      return next;
    });
  }, []);
  const stop = useCallback(() => setNow(null), []);
  const claim = useCallback(() => {
    setSlots((n) => n + 1);
    return () => setSlots((n) => n - 1);
  }, []);
  const api = useMemo(() => ({ now, status, play, stop, recent, lang, claim }), [now, status, play, stop, recent, lang, claim]);
  const check = () => setHasVideo((ref.current?.videoWidth ?? 0) > 0);

  return (
    <Ctx.Provider value={api}>
      <div className="player-root" data-playing={now ? 'true' : undefined} data-docked={now && slots === 0 ? 'true' : undefined}>
        {children}
        <div className={now && hasVideo ? 'player-screen on' : 'player-screen'}>
          <video
            ref={ref}
            controls={hasVideo}
            playsInline
            preload="none"
            onLoadedMetadata={check}
            onResize={check}
            onError={() => now && setStatus('failed')}
            onPlaying={() => setStatus('playing')}
            onWaiting={() => setStatus('connecting')}
          />
        </div>
        {now && slots === 0 && (
          <div className="player-dock">
            <PlayerBar />
          </div>
        )}
      </div>
    </Ctx.Provider>
  );
}

/** The player's one row: logo, name, state and Stop. Live radio cannot be wound back, so there is no time line. */
export function PlayerBar() {
  const { now, status, stop, lang } = usePlayer();
  const t = strings(lang);
  if (!now) return null;
  return (
    <section className="player compact" aria-label={t.playerNow(now.name)} data-testid="player" data-state={status}>
      {/* eslint-disable-next-line @next/next/no-img-element -- small same-origin logo */}
      {now.logo && <img className="explore-logo" src={now.logo} alt="" width={36} height={36} decoding="async" />}
      <span className="player-text">
        <span className="player-name">{now.name}</span>
        <span role={status === 'failed' ? 'alert' : 'status'} className="player-state" data-state={status}>
          {status === 'failed' ? t.playerFailed : status === 'playing' ? t.playerPlaying : t.playerConnecting}
        </span>
      </span>
      <span className="player-eq" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <button type="button" className="player-stop" aria-label={t.playerStop} title={t.playerStop} onClick={stop}>
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <rect x="6.5" y="6.5" width="11" height="11" rx="2" fill="currentColor" />
        </svg>
      </button>
    </section>
  );
}

/** Where a page draws the player itself (the explorer floats it on the map); the frame's bar hides meanwhile. */
export function PlayerSlot({ className }: { className: string }) {
  const { now, claim } = usePlayer();
  useEffect(() => claim(), [claim]);
  return now ? (
    <div className={className}>
      <PlayerBar />
    </div>
  ) : null;
}
