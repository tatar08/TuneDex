'use client';

import { useEffect, useRef, useState } from 'react';
import type HlsType from 'hls.js';
import { Lang, strings } from '@/lib/i18n';

export interface NowPlaying {
  name: string;
  url: string;
  hls: boolean;
  /** The station's logo, for the compact player. */
  logo?: string;
}

/**
 * One player for the page: radio and video use the same element, and the picture area shows only when the stream
 * carries video. HLS plays natively in Safari and through hls.js elsewhere (loaded only when needed, no worker, so
 * the CSP needs no blob: workers).
 *
 * `compact` is the one-row player of the radio explorer (Tar 2026-10-10): logo, name, state and Stop. Live radio
 * cannot be wound back, so the browser's own bar with its time line is left out; volume is the device's.
 */
export function MediaPlayer({ lang, item, onStop, compact = false }: { lang: Lang; item: NowPlaying; onStop: () => void; compact?: boolean }) {
  const t = strings(lang);
  const ref = useRef<HTMLVideoElement>(null);
  const [hasVideo, setHasVideo] = useState(false);
  const [failed, setFailed] = useState(false);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    setHasVideo(false);
    setFailed(false);
    setPlaying(false);
    let hls: HlsType | null = null;
    let cancelled = false;
    const play = () => void video.play().catch(() => undefined);
    if (item.hls && !video.canPlayType('application/vnd.apple.mpegurl')) {
      void import('hls.js').then(({ default: Hls }) => {
        if (cancelled) return;
        if (!Hls.isSupported()) return setFailed(true);
        hls = new Hls({ enableWorker: false, lowLatencyMode: false });
        hls.on(Hls.Events.ERROR, (_e, data) => {
          if (data.fatal) setFailed(true);
        });
        hls.loadSource(item.url);
        hls.attachMedia(video);
        play();
      }, () => setFailed(true));
    } else {
      video.src = item.url;
      play();
    }
    return () => {
      cancelled = true;
      hls?.destroy();
      video.pause();
      video.removeAttribute('src');
      video.load();
    };
  }, [item.url, item.hls]);

  const check = () => setHasVideo((ref.current?.videoWidth ?? 0) > 0);

  if (compact) {
    const state = failed ? 'failed' : playing ? 'playing' : 'connecting';
    return (
      <section className="player compact" aria-label={t.playerNow(item.name)} data-testid="player" data-state={state}>
        {/* eslint-disable-next-line @next/next/no-img-element -- small same-origin logo */}
        {item.logo && <img className="explore-logo" src={item.logo} alt="" width={36} height={36} decoding="async" />}
        <span className="player-text">
          <span className="player-name">{item.name}</span>
          <span role={failed ? 'alert' : 'status'} className="player-state" data-state={state}>
            {failed ? t.playerFailed : playing ? t.playerPlaying : t.playerConnecting}
          </span>
        </span>
        <span className="player-eq" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <button type="button" className="player-stop" aria-label={t.playerStop} title={t.playerStop} onClick={onStop}>
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <rect x="6.5" y="6.5" width="11" height="11" rx="2" fill="currentColor" />
          </svg>
        </button>
        <video
          ref={ref}
          className="player-video compact"
          playsInline
          preload="none"
          onError={() => setFailed(true)}
          onPlaying={() => setPlaying(true)}
          onWaiting={() => setPlaying(false)}
        />
      </section>
    );
  }

  return (
    <section className="player" aria-label={t.playerNow(item.name)} data-testid="player">
      <div className="player-head">
        <span className="device-name">{t.playerNow(item.name)}</span>
        <button type="button" className="btn secondary small" onClick={onStop}>
          {t.playerStop}
        </button>
      </div>
      <video
        ref={ref}
        className={hasVideo ? 'player-video' : 'player-video audio-only'}
        controls
        playsInline
        preload="none"
        onLoadedMetadata={check}
        onResize={check}
        onError={() => setFailed(true)}
        onPlaying={() => setPlaying(true)}
        onWaiting={() => setPlaying(false)}
      />
      {failed ? (
        <p role="alert" className="status player-state" data-state="failed">
          {t.playerFailed}
        </p>
      ) : (
        <p role="status" className="status player-state" data-state={playing ? 'playing' : 'connecting'}>
          {playing ? t.playerPlaying : t.playerConnecting}
        </p>
      )}
    </section>
  );
}
