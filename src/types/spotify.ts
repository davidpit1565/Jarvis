export interface SpotifyTrack {
  name: string;
  artists: string[];
  album: string;
  uri: string;
}

export interface SpotifyPlaybackState {
  isPlaying: boolean;
  track: SpotifyTrack | null;
  deviceName: string | null;
}

export interface SpotifyPlaylist {
  name: string;
  /** Owner's Spotify display name, when known — helps distinguish two playlists with the same name. */
  ownerName: string | null;
  trackCount: number;
  /** A playlist's context URI (spotify:playlist:...), passed as Spotify's own `context_uri` to play it as a queue — distinct from a track's `uri`, which plays a single song. */
  uri: string;
}
