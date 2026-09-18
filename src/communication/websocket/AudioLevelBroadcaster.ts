export interface AudioLevelSink {
  send(data: string): void;
}

/**
 * Fans out live phone-call audio levels to any dashboard browser tabs
 * watching (`GET /dashboard/audio-ws`). Deliberately one-way and
 * ephemeral — no history, no persistence, just "what's the level right
 * now" pushed to whoever's currently connected.
 */
export class AudioLevelBroadcaster {
  private viewers: Set<AudioLevelSink> = new Set();

  addViewer(sink: AudioLevelSink): void {
    this.viewers.add(sink);
  }

  removeViewer(sink: AudioLevelSink): void {
    this.viewers.delete(sink);
  }

  broadcast(level: number, track: "inbound" | "outbound"): void {
    const message = JSON.stringify({ type: "level", level, track });
    for (const viewer of this.viewers) {
      viewer.send(message);
    }
  }

  get viewerCount(): number {
    return this.viewers.size;
  }
}
