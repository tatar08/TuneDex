/** A station or link the shared player (../player/Player.tsx) can play. */
export interface NowPlaying {
  name: string;
  url: string;
  hls: boolean;
  /** The station's logo, shown beside its name. */
  logo?: string;
}
