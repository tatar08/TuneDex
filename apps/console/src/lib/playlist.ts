/** A channel the viewer added on the web. It lives only in this browser (Doc 10: private sources never reach the server). */
export interface WebChannel {
  id: string;
  name: string;
  url: string;
  group?: string;
  /** HLS needs hls.js outside Safari. */
  hls: boolean;
}

export const MAX_CHANNELS = 2000;
/** localStorage key of the viewer's own channels, shared by /app/radio and /app/explore. */
export const CHANNELS_KEY = 'tunedeck.web.channels';
const MAX_NAME = 120;

/** Only https addresses play: an http stream is refused, as in the app. */
export function httpsUrl(raw: string): URL | null {
  try {
    const url = new URL(raw.trim());
    return url.protocol === 'https:' && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}

export const looksHls = (url: string) => /\.m3u8($|[?#])/i.test(url);

/** An HLS media or master playlist, as opposed to an IPTV channel list. */
export const isHlsPlaylist = (text: string) => /#EXT-X-(TARGETDURATION|STREAM-INF|MEDIA-SEQUENCE)/.test(text);

/** Reads an M3U channel list. Non-https entries are counted and dropped. */
export function parseM3u(text: string, makeId: () => string): { channels: WebChannel[]; refused: number } {
  const channels: WebChannel[] = [];
  let refused = 0;
  let name = '';
  let group: string | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF')) {
      // Attribute values may hold commas, so the title starts after the last quoted attribute when there is one.
      let comma = line.indexOf(',', line.lastIndexOf('"') + 1);
      if (comma < 0) comma = line.indexOf(',');
      name = comma >= 0 ? line.slice(comma + 1).trim() : '';
      group = /group-title="([^"]*)"/.exec(line)?.[1]?.trim() || undefined;
      continue;
    }
    if (line.startsWith('#')) continue;
    const url = httpsUrl(line);
    if (!url) refused++;
    else if (channels.length < MAX_CHANNELS) {
      channels.push({ id: makeId(), name: (name || url.hostname).slice(0, MAX_NAME), url: url.href, group: group?.slice(0, MAX_NAME), hls: looksHls(url.href) });
    }
    name = '';
    group = undefined;
  }
  return { channels, refused };
}

/** Reads what localStorage holds, dropping anything malformed or no longer https. */
export function readChannels(raw: string | null): WebChannel[] {
  if (!raw) return [];
  try {
    const list = JSON.parse(raw) as unknown;
    if (!Array.isArray(list)) return [];
    return list
      .filter((c): c is WebChannel => !!c && typeof c.id === 'string' && typeof c.name === 'string' && typeof c.url === 'string' && !!httpsUrl(c.url))
      .slice(0, MAX_CHANNELS)
      .map((c) => ({ id: c.id, name: c.name.slice(0, MAX_NAME), url: c.url, group: typeof c.group === 'string' ? c.group : undefined, hls: c.hls === true || looksHls(c.url) }));
  } catch {
    return [];
  }
}

/** Adds one channel to this browser's own list; false when it was already there or storage is unavailable. */
export function appendChannel(channel: WebChannel): boolean {
  try {
    const list = readChannels(localStorage.getItem(CHANNELS_KEY));
    if (list.some((c) => c.url === channel.url) || list.length >= MAX_CHANNELS) return false;
    localStorage.setItem(CHANNELS_KEY, JSON.stringify([...list, channel]));
    return true;
  } catch {
    return false;
  }
}
