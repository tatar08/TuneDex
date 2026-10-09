'use client';

import { useEffect, useState } from 'react';
import { Lang, strings } from '@/lib/i18n';
import { CHANNELS_KEY as KEY, httpsUrl, isHlsPlaylist, looksHls, MAX_CHANNELS, parseM3u, readChannels, WebChannel } from '@/lib/playlist';
import type { NowPlaying } from './MediaPlayer';

const MAX_BYTES = 5_000_000;

/** The start of what the address serves when it looks like text, so an endless audio stream is never downloaded. */
async function readList(url: string): Promise<string> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 10_000);
  try {
    const res = await fetch(url, { credentials: 'omit', signal: abort.signal });
    if (!res.ok || !res.body || !/mpegurl|text|octet-stream|^$/i.test(res.headers.get('content-type') ?? '')) return '';
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      // A list starts with #EXTM3U; anything else is a stream, not a list, so reading stops.
      if (text.length > MAX_BYTES || (text.length >= 7 && !text.trimStart().startsWith('#EXTM3U'))) break;
    }
    void reader.cancel().catch(() => undefined);
    return text.slice(0, MAX_BYTES);
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
    abort.abort();
  }
}

/**
 * The viewer's own links and M3U lists for TV and radio. They stay in this browser's storage and are never sent to
 * the TuneDeck server; the host is shown before anything plays.
 */
export function MyChannels({ lang, playing, onPlay }: { lang: Lang; playing: string | null; onPlay: (item: NowPlaying) => void }) {
  const t = strings(lang);
  const [channels, setChannels] = useState<WebChannel[]>([]);
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ error: boolean; text: string } | null>(null);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    try {
      setChannels(readChannels(localStorage.getItem(KEY)));
    } catch {
      setChannels([]);
    }
  }, []);

  function save(next: WebChannel[]) {
    const list = next.slice(0, MAX_CHANNELS);
    setChannels(list);
    try {
      localStorage.setItem(KEY, JSON.stringify(list));
    } catch {
      setNote({ error: true, text: t.mineNotSaved });
    }
  }

  function merge(found: WebChannel[], refused: number) {
    const known = new Set(channels.map((c) => c.url));
    const fresh = found.filter((c) => !known.has(c.url) && known.add(c.url));
    save([...channels, ...fresh]);
    setNote({ error: fresh.length === 0, text: t.mineAdded(fresh.length, refused) });
  }

  async function addLink(e: React.FormEvent) {
    e.preventDefault();
    const url = httpsUrl(link);
    if (!url) return setNote({ error: true, text: t.mineHttpsOnly });
    setBusy(true);
    setNote(null);
    try {
      // A list is read here when its server allows the browser to; otherwise the address is kept as one stream.
      const text = await readList(url.href);
      if (text.trimStart().startsWith('#EXTM3U') && !isHlsPlaylist(text)) {
        const { channels: found, refused } = parseM3u(text, () => crypto.randomUUID());
        merge(found, refused);
      } else {
        merge([{ id: crypto.randomUUID(), name: url.hostname, url: url.href, hls: isHlsPlaylist(text) || looksHls(url.href) }], 0);
      }
      setLink('');
    } finally {
      setBusy(false);
    }
  }

  async function addFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > MAX_BYTES) return setNote({ error: true, text: t.mineTooBig });
    const { channels: found, refused } = parseM3u(await file.text(), () => crypto.randomUUID());
    merge(found, refused);
  }

  const q = filter.trim().toLowerCase();
  const shown = q ? channels.filter((c) => c.name.toLowerCase().includes(q) || c.group?.toLowerCase().includes(q)) : channels;

  return (
    <section className="device" aria-labelledby="mine-title">
      <h2 id="mine-title">{t.mineTitle}</h2>
      <p className="status">{t.mineLede}</p>
      <form className="mine-add" onSubmit={addLink}>
        <label className="sr-only" htmlFor="mine-link">
          {t.mineLink}
        </label>
        <input id="mine-link" type="url" inputMode="url" placeholder="https://…" value={link} onChange={(e) => setLink(e.target.value)} required />
        <button type="submit" className="btn small" disabled={busy}>
          {t.mineAdd}
        </button>
        <label className="btn secondary small file-pick">
          {t.mineFile}
          <input type="file" accept=".m3u,.m3u8,audio/x-mpegurl,application/vnd.apple.mpegurl,text/plain" onChange={addFile} />
        </label>
      </form>
      {note && (
        <p role={note.error ? 'alert' : 'status'} className="status">
          {note.text}
        </p>
      )}
      {channels.length > 0 && (
        <>
          <div className="mine-tools">
            {channels.length > 10 && (
              <input type="search" aria-label={t.mineSearch} placeholder={t.mineSearch} value={filter} onChange={(e) => setFilter(e.target.value)} />
            )}
            <button type="button" className="btn secondary small" onClick={() => (window.confirm(t.mineClearConfirm) ? save([]) : undefined)}>
              {t.mineClear}
            </button>
          </div>
          <ul className="devices radio-list">
            {shown.slice(0, 200).map((c) => (
              <li key={c.id} data-testid="channel">
                <span className="device-name">{c.name}</span>
                <span className="radio-actions">
                  <button
                    type="button"
                    className="btn secondary small"
                    aria-pressed={playing === c.url}
                    aria-label={t.playerPlay(c.name)}
                    onClick={() => onPlay({ name: c.name, url: c.url, hls: c.hls })}
                  >
                    ▶
                  </button>
                  <button type="button" className="btn secondary small" aria-label={t.mineRemove(c.name)} onClick={() => save(channels.filter((x) => x.id !== c.id))}>
                    ✕
                  </button>
                </span>
                <span className="status">{[c.group, new URL(c.url).hostname].filter(Boolean).join(' · ')}</span>
              </li>
            ))}
          </ul>
          {shown.length > 200 && <p className="status">{t.mineMore(shown.length - 200)}</p>}
        </>
      )}
    </section>
  );
}
