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
