'use client';
import { useEffect, useState } from 'react';
import { strings, Lang } from '@/lib/i18n';
import { usePlayer } from '../player/Player';
import type { NowPlaying } from '../radio/MediaPlayer';
const KEY = 'tunedeck.web.presets';
/** Browser-only, explicit save/remove; choosing a slot never autoplays. */
export function Presets({ lang, candidate }: { lang: Lang; candidate: NowPlaying | null }) {
  const t = strings(lang);
  const { play } = usePlayer();
  const [slots, setSlots] = useState<(NowPlaying | null)[]>(Array(6).fill(null));
  const [failed, setFailed] = useState(false);
  useEffect(() => { try {
    const data: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    if (Array.isArray(data)) setSlots(Array.from({ length: 6 }, (_, i) => { const x = data[i]; return x && typeof x.name === 'string' && typeof x.url === 'string' && /^https:\/\//.test(x.url) ? { name: x.name, url: x.url, hls: x.hls === true } : null; }));
  } catch { /* malformed data is not played */ } }, []);
  const save = (i: number, value: NowPlaying | null) => {
    const next = slots.map((s, n) => n === i ? value : s); setSlots(next);
    try { localStorage.setItem(KEY, JSON.stringify(next)); setFailed(false); } catch { setFailed(true); }
  };
  return <section className="theme-presets" aria-label={t.presetsTitle}>
    <h2>{t.presetsTitle}</h2><p className="status">{t.presetsLocal}</p>
    <ol>{slots.map((s, i) => <li key={i}>
      <span>{i + 1}</span>{s ? <><button type="button" onClick={() => play(s)} aria-label={t.playerPlay(s.name)}>{s.name}</button><button type="button" onClick={() => save(i, null)} aria-label={t.presetRemove(i + 1)}>×</button></> : <button type="button" disabled={!candidate} onClick={() => save(i, candidate)} aria-label={t.presetSave(i + 1)}>{candidate ? candidate.name : t.listenChoose}</button>}
    </li>)}</ol>{failed && <p role="alert">{t.presetsFailed}</p>}
  </section>;
}
