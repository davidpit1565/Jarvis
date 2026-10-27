/**
 * The channels a proactive watcher notification can actually go out on.
 * "phone" is included for completeness (so the router can target it once
 * a number exists) but is not live today — see `WatcherNotifier`'s own
 * doc comment and `CLAUDE.md`'s explicit note: David has not connected a
 * phone number for Twilio, so this channel must behave as an honest
 * no-op, never a half-built attempt at a call path that doesn't work.
 */
export type WatcherChannel = "telegram" | "device-announce" | "phone";

export interface WatcherChannelConfig {
  /**
   * Source ids David has explicitly configured as warranting the louder
   * device-announce channel instead of the default quiet Telegram note.
   * Exact source-id match only (e.g. "news:ai safety", "github:owner/repo")
   * — deliberately NOT a judgment call the model makes per item. Per
   * CLAUDE.md: "Never let the model itself decide in the moment that
   * something is 'call-worthy' with no prior rule saying so."
   */
  highPrioritySourceIds: ReadonlySet<string>;
  /**
   * Source ids configured for the phone-call channel. Kept structurally
   * distinct from `highPrioritySourceIds` so a future phone number being
   * connected doesn't silently promote every existing high-priority
   * source onto a channel nobody asked for — phone routing must be its
   * own explicit opt-in, same conservative posture as everything else
   * here.
   */
  phoneSourceIds: ReadonlySet<string>;
}

export interface WatcherRoutingDecision {
  channel: WatcherChannel;
  /** Why this channel was chosen — for logging/activity-log, never shown to the user as-is. */
  reason: string;
}

/**
 * Decides which channel a given watch source's new-activity notification
 * should go out on. Deliberately a pure function over explicit config, not
 * a model call and not per-item content inspection — the whole point of
 * CLAUDE.md's spec here is that channel escalation is "an explicit,
 * conservative design question — not JARVIS's unilateral call." The
 * default for everything is the quietest channel (Telegram); only a
 * source David has explicitly flagged ahead of time gets anything louder.
 */
export function routeWatcherSource(sourceId: string, config: WatcherChannelConfig): WatcherRoutingDecision {
  if (config.phoneSourceIds.has(sourceId)) {
    return { channel: "phone", reason: `source "${sourceId}" is explicitly configured for the phone channel` };
  }
  if (config.highPrioritySourceIds.has(sourceId)) {
    return { channel: "device-announce", reason: `source "${sourceId}" is explicitly configured as high-priority` };
  }
  return { channel: "telegram", reason: "default channel (no explicit high-priority/phone rule configured for this source)" };
}

export function emptyWatcherChannelConfig(): WatcherChannelConfig {
  return { highPrioritySourceIds: new Set(), phoneSourceIds: new Set() };
}
