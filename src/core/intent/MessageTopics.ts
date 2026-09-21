/**
 * Deterministic (no LLM call), keyword/pattern-based topic classification
 * for a user message. This is the single shared building block for both
 * the Fast Path classifier (`FastPathClassifier.ts`) and Dynamic Tool
 * Scoping (`ToolScoping.ts`) — per the task's own instruction not to
 * duplicate similar keyword-matching logic in two places. Neither consumer
 * makes an AI call to do this classification; both stay conservative and
 * fall back to the safe/full option whenever a message doesn't clearly
 * match.
 *
 * This module only ever tags topics — it never decides what to *do* about
 * them. That decision (fast-path a single tool call, or scope down the
 * tool list) lives in the two consumer modules, since the two have
 * different tolerance for false positives (a fast-path false positive is a
 * real bug; a tool-scoping false negative just means a bloated tool list,
 * which is explicitly the safer failure mode).
 */

export type MessageTopic =
  | "weather"
  | "calendar"
  | "spotify"
  | "email"
  | "telegram"
  | "news"
  | "reminders"
  | "commitments"
  | "alarms"
  | "wakeup"
  | "automation"
  | "memory"
  | "files"
  | "system"
  | "images"
  | "studio"
  | "phone"
  | "history"
  | "undo"
  | "devices";

/**
 * Keyword/phrase matchers per topic, checked against the lowercased
 * message text. Deliberately simple substring/word matching, not regex
 * gymnastics — false negatives here just mean a topic isn't detected (safe:
 * both consumers treat "no/ambiguous topic" as "don't narrow anything"),
 * so there's no pressure to make these exhaustive.
 */
const TOPIC_KEYWORDS: Record<MessageTopic, string[]> = {
  weather: [
    "weather",
    "temperature",
    "raining",
    "rain",
    "forecast",
    "sunny",
    "how cold",
    "how hot",
    "jacket",
    "umbrella",
  ],
  calendar: [
    "calendar",
    "meeting",
    "meetings",
    "appointment",
    "schedule",
    "my agenda",
    "am i free",
    "on my calendar",
    "what do i have today",
    "do i have anything today",
  ],
  spotify: ["spotify", "music", "song", "playlist", "track", "pause", "resume", "unpause", "skip", "playing"],
  email: ["email", "gmail", "inbox", "unread mail", "draft", "compose a message", "reply to"],
  telegram: ["telegram", "notify me", "send me a message", "text me on telegram"],
  news: ["news", "headline", "headlines", "what's happening in the world"],
  reminders: ["remind", "reminder", "reminders"],
  commitments: ["commitment", "commitments", "promise", "promised"],
  alarms: ["alarm", "alarms", "wake me up at"],
  wakeup: ["wake-up call", "wake up call", "call me at"],
  automation: ["automation", "automation rule", "automate"],
  memory: ["remember", "memory", "forget", "recall"],
  files: ["file", "files", "folder", "directory", "write to disk", "read the file"],
  system: ["open the app", "quit the app", "application", "volume", "wifi", "trash", "running apps", "screen"],
  images: ["generate an image", "draw", "picture of", "image of"],
  studio: ["reel", "reels", "instagram", "publish"],
  phone: ["text ", "sms", "phone number", "call my phone"],
  history: ["conversation history", "what did we talk about", "earlier you said"],
  undo: ["undo", "take that back"],
  devices: ["my devices", "connected devices", "which device"],
};

/**
 * Returns every topic whose keywords appear anywhere in `text` (case
 * insensitive substring match). `text` can be just the current user
 * message, or that message plus recent conversation context concatenated
 * — callers decide how much context to feed in.
 */
export function classifyMessageTopics(text: string): Set<MessageTopic> {
  const lower = text.toLowerCase();
  const topics = new Set<MessageTopic>();
  for (const topic of Object.keys(TOPIC_KEYWORDS) as MessageTopic[]) {
    if (TOPIC_KEYWORDS[topic].some((keyword) => lower.includes(keyword))) {
      topics.add(topic);
    }
  }
  return topics;
}
