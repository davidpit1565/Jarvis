import { classifyMessageTopics, type MessageTopic } from "./MessageTopics";

/** A deterministic fast-path match: the one tool (by its registry `name`) to call, and the exact input to call it with. */
export interface FastPathMatch {
  toolName: string;
  input: Record<string, unknown>;
  /** Which recognized shape matched — for observability (`fastPath.hit`'s payload), never used for control flow. */
  shape: string;
}

interface FastPathRule {
  shape: string;
  topic: MessageTopic;
  pattern: RegExp;
  toolName: string;
  input: Record<string, unknown> | ((match: RegExpMatchArray) => Record<string, unknown>);
}

/**
 * Every pattern here is anchored to the ENTIRE normalized message
 * (`^...$`) — a deliberate choice to keep this classifier conservative:
 * a message that says anything more than one of these exact simple shapes
 * ("weather in Tel Aviv tomorrow", "play Bohemian Rhapsody", "what's on my
 * calendar and did I get any email") never matches and correctly falls
 * through to the full path. False negatives (falling through) are fine and
 * expected; a false positive is a real bug, so every pattern here is
 * intentionally narrow rather than clever.
 */
const RULES: FastPathRule[] = [
  // --- Weather (current conditions only — forecast/"tomorrow"/a named city
  // never matches, since those need a different tool or an argument this
  // classifier has no safe way to fill in). ---
  {
    shape: "weather.current",
    topic: "weather",
    pattern: /^(what'?s|what is|whats|how'?s|hows) (the )?weather( (like|today|right now|outside|currently))?$/,
    toolName: "get_weather",
    input: {},
  },
  { shape: "weather.current", topic: "weather", pattern: /^weather( (today|right now|outside))?$/, toolName: "get_weather", input: {} },
  {
    shape: "weather.current",
    topic: "weather",
    pattern: /^is it (going to |gonna )?rain(ing)?( today| right now| outside)?$/,
    toolName: "get_weather",
    input: {},
  },
  { shape: "weather.current", topic: "weather", pattern: /^will it rain( today)?$/, toolName: "get_weather", input: {} },
  { shape: "weather.current", topic: "weather", pattern: /^do i need (a jacket|an umbrella)$/, toolName: "get_weather", input: {} },

  // --- Calendar (today's events, no filters). ---
  {
    shape: "calendar.today",
    topic: "calendar",
    pattern: /^what'?s on (my )?calendar( today)?$/,
    toolName: "list_calendar_events",
    input: {},
  },
  {
    shape: "calendar.today",
    topic: "calendar",
    pattern: /^what do i have (on my calendar )?today$/,
    toolName: "list_calendar_events",
    input: {},
  },
  {
    shape: "calendar.today",
    topic: "calendar",
    pattern: /^do i have anything (on (my calendar )?)?today$/,
    toolName: "list_calendar_events",
    input: {},
  },
  { shape: "calendar.today", topic: "calendar", pattern: /^am i free today$/, toolName: "list_calendar_events", input: {} },
  { shape: "calendar.today", topic: "calendar", pattern: /^what'?s my schedule( today)?$/, toolName: "list_calendar_events", input: {} },
  {
    shape: "calendar.today",
    topic: "calendar",
    pattern: /^what meetings do i have today$/,
    toolName: "list_calendar_events",
    input: {},
  },

  // --- Spotify: pause. ---
  { shape: "spotify.pause", topic: "spotify", pattern: /^pause( the)? (music|spotify|song)$/, toolName: "pause_music", input: {} },
  { shape: "spotify.pause", topic: "spotify", pattern: /^pause$/, toolName: "pause_music", input: {} },
  { shape: "spotify.pause", topic: "spotify", pattern: /^stop( the)? (music|spotify|song)$/, toolName: "pause_music", input: {} },

  // --- Spotify: play/resume (never a song name — that needs a real
  // "query" the classifier can't safely guess at, so it falls through). ---
  { shape: "spotify.play", topic: "spotify", pattern: /^play( the)? music$/, toolName: "play_music", input: {} },
  { shape: "spotify.play", topic: "spotify", pattern: /^play spotify$/, toolName: "play_music", input: {} },
  { shape: "spotify.play", topic: "spotify", pattern: /^resume( the)? (music|spotify|song)$/, toolName: "play_music", input: {} },
  { shape: "spotify.play", topic: "spotify", pattern: /^unpause( the)?( music| spotify)?$/, toolName: "play_music", input: {} },

  // --- Spotify: skip. ---
  { shape: "spotify.skip.next", topic: "spotify", pattern: /^skip( this)? (song|track)$/, toolName: "skip_track", input: {} },
  { shape: "spotify.skip.next", topic: "spotify", pattern: /^skip$/, toolName: "skip_track", input: {} },
  { shape: "spotify.skip.next", topic: "spotify", pattern: /^next (song|track)$/, toolName: "skip_track", input: {} },
  {
    shape: "spotify.skip.previous",
    topic: "spotify",
    pattern: /^(go back|previous|last) (a )?(song|track)$/,
    toolName: "skip_track",
    input: { direction: "previous" },
  },
  {
    shape: "spotify.skip.previous",
    topic: "spotify",
    pattern: /^play the previous (song|track)$/,
    toolName: "skip_track",
    input: { direction: "previous" },
  },

  // --- Spotify: what's playing right now. ---
  { shape: "spotify.nowPlaying", topic: "spotify", pattern: /^what'?s playing$/, toolName: "get_currently_playing", input: {} },
  { shape: "spotify.nowPlaying", topic: "spotify", pattern: /^what'?s currently playing$/, toolName: "get_currently_playing", input: {} },
  { shape: "spotify.nowPlaying", topic: "spotify", pattern: /^what song is (this|playing)$/, toolName: "get_currently_playing", input: {} },
  { shape: "spotify.nowPlaying", topic: "spotify", pattern: /^what is playing( right now)?$/, toolName: "get_currently_playing", input: {} },
];

function normalize(message: string): string {
  return message.trim().toLowerCase().replace(/[?!.]+$/, "").replace(/\s+/g, " ");
}

/**
 * Deterministic single-tool-call fast-path classifier — no LLM call. Bias
 * is strongly toward returning `null` (fall through to the full brain
 * round-trip): a message only matches when it is, in its entirety, one of
 * a small set of known-safe simple shapes. See `RULES`'s own doc comment
 * for the reasoning behind that conservatism.
 *
 * As a second, independent guard on top of each rule's own anchored
 * pattern, this also re-checks the message against the shared topic
 * classifier (`classifyMessageTopics`, the same module Dynamic Tool
 * Scoping uses) and requires that the matched rule's topic be the ONLY
 * topic detected — a defense-in-depth check against a keyword gap letting
 * a genuinely multi-topic message slip through a single rule.
 */
export function classifyFastPath(message: string): FastPathMatch | null {
  const normalized = normalize(message);
  if (!normalized) return null;

  for (const rule of RULES) {
    const match = normalized.match(rule.pattern);
    if (!match) continue;

    const topics = classifyMessageTopics(normalized);
    if (topics.size !== 1 || !topics.has(rule.topic)) continue;

    const input = typeof rule.input === "function" ? rule.input(match) : rule.input;
    return { toolName: rule.toolName, input, shape: rule.shape };
  }

  return null;
}
