import { describe, expect, it } from 'vitest';
import { httpsUrl, isHlsPlaylist, parseM3u, readChannels } from '@/lib/playlist';

let n = 0;
const id = () => `c${++n}`;

describe('web playlists', () => {
  it('reads names and groups and drops non-https entries', () => {
    const { channels, refused } = parseM3u(
      [
        '#EXTM3U',
        '#EXTINF:-1 tvg-name="News, 24h" group-title="News",Thai News',
        'https://tv.example.test/news/index.m3u8',
        '#EXTINF:-1,Old http channel',
        'http://insecure.example.test/a.m3u8',
        '#EXTINF:-1,Jazz "Live"',
        'https://radio.example.test/jazz.mp3',
        'file:///etc/passwd',
      ].join('\n'),
      id,
    );
    expect(refused).toBe(2);
    expect(channels.map((c) => [c.name, c.group, c.hls])).toEqual([
      ['Thai News', 'News', true],
      ['Jazz "Live"', undefined, false],
    ]);
  });

  it('tells an HLS stream from a channel list', () => {
    expect(isHlsPlaylist('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nlow.m3u8')).toBe(true);
    expect(isHlsPlaylist('#EXTM3U\n#EXTINF:-1,A\nhttps://a.test/x')).toBe(false);
  });

  it('accepts https only, without credentials in the address', () => {
    expect(httpsUrl('https://a.test/x')?.hostname).toBe('a.test');
    expect(httpsUrl('http://a.test/x')).toBeNull();
    expect(httpsUrl('https://u:p@a.test/x')).toBeNull();
    expect(httpsUrl('javascript:alert(1)')).toBeNull();
  });

  it('ignores malformed or non-https stored entries', () => {
    const stored = JSON.stringify([{ id: '1', name: 'A', url: 'https://a.test/x.m3u8' }, { id: '2', name: 'B', url: 'http://b.test' }, 'junk']);
    expect(readChannels(stored)).toEqual([{ id: '1', name: 'A', url: 'https://a.test/x.m3u8', group: undefined, hls: true }]);
    expect(readChannels('{bad')).toEqual([]);
  });
});
