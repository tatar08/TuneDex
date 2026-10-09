'use client';

import { useEffect, useRef, useState } from 'react';
import type HlsType from 'hls.js';
import { Lang, strings } from '@/lib/i18n';

export interface NowPlaying {
  name: string;
  url: string;
  hls: boolean;
}

/**
 * One player for the page: radio and video use the same element, and the picture area shows only when the stream
 * carries video. HLS plays natively in Safari and through hls.js elsewhere (loaded only when needed, no worker, so
 * the CSP needs no blob: workers).
 */
export function MediaPlayer({ lang, item, onStop }: { lang: Lang; item: NowPlaying; onStop: () => void }) {
  const t = strings(lang);
  const ref = useRef<HTMLVideoElement>(null);
  const [hasVideo, setHasVideo] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    setHasVideo(false);
    setFailed(false);
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
      />
      {failed && (
        <p role="alert" className="status">
          {t.playerFailed}
        </p>
      )}
    </section>
  );
}
