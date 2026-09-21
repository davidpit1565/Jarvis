import type { Tool } from "@/types/tools";
import { classifyMessageTopics, type MessageTopic } from "./MessageTopics";

/**
 * Tools always exposed to the brain regardless of topic — cheap to reason
 * about and used across almost every kind of request (memory, reminders,
 * undoing a mistake). Per the task's own instruction: "Always include a
 * safe default core set ... if that's cheap to reason about."
 */
const CORE_TOOL_IDS: readonly string[] = [
  "SAVE_MEMORY",
  "SEARCH_MEMORY",
  "DELETE_MEMORY",
  "CREATE_REMINDER",
  "LIST_REMINDERS",
  "UPDATE_REMINDER",
  "COMPLETE_REMINDER",
  "DELETE_REMINDER",
  "UNDO_LAST_ACTION",
];

/**
 * Which tool ids belong to each topic, by their registry `id` (stable,
 * unlike the human-facing `name`). A tool whose id doesn't appear anywhere
 * in this map is treated as "unclassified" and is always included by
 * `scopeToolsForMessage` — see its own doc comment for why that's the
 * conservative choice.
 */
const TOPIC_TOOL_IDS: Record<MessageTopic, readonly string[]> = {
  weather: ["GET_WEATHER", "GET_WEATHER_FORECAST"],
  calendar: [
    "LIST_CALENDAR_EVENTS",
    "GET_CALENDAR_EVENT",
    "SEARCH_CALENDAR_EVENTS",
    "CREATE_CALENDAR_EVENT",
    "UPDATE_CALENDAR_EVENT",
    "DELETE_CALENDAR_EVENT",
    "UNLINK_CALENDAR",
  ],
  spotify: ["PLAY_MUSIC", "PAUSE_MUSIC", "SKIP_TRACK", "GET_CURRENTLY_PLAYING", "UNLINK_SPOTIFY"],
  email: ["GET_EMAIL", "SEARCH_EMAIL", "SEND_EMAIL", "REPLY_EMAIL", "GET_UNREAD_EMAIL_COUNT", "COMPOSE_EMAIL_DRAFT"],
  telegram: ["NOTIFY_USER", "SHARE_FILE_TO_PHONE"],
  news: ["GET_NEWS", "SEARCH_NEWS"],
  reminders: ["CREATE_REMINDER", "LIST_REMINDERS", "UPDATE_REMINDER", "COMPLETE_REMINDER", "DELETE_REMINDER"],
  commitments: ["CREATE_COMMITMENT", "LIST_COMMITMENTS", "FULFILL_COMMITMENT"],
  alarms: ["CREATE_ALARM", "LIST_ALARMS", "UPDATE_ALARM", "DELETE_ALARM"],
  wakeup: ["CREATE_WAKEUP_CALL", "LIST_WAKEUP_CALLS", "UPDATE_WAKEUP_CALL", "DELETE_WAKEUP_CALL"],
  automation: ["CREATE_AUTOMATION_RULE", "LIST_AUTOMATION_RULES", "UPDATE_AUTOMATION_RULE", "DELETE_AUTOMATION_RULE"],
  memory: ["SAVE_MEMORY", "SEARCH_MEMORY", "DELETE_MEMORY"],
  files: ["READ_TEXT_FILE", "WRITE_FILE", "READ_FILE_BYTES", "READ_ONLY_FILE_INFO", "LIST_DIRECTORY", "CREATE_FOLDER"],
  system: [
    "OPEN_APPLICATION",
    "QUIT_APPLICATION",
    "LIST_RUNNING_APPLICATIONS",
    "TYPE_TEXT",
    "CLICK_ELEMENT",
    "SET_VOLUME",
    "TOGGLE_WIFI",
    "EMPTY_TRASH",
    "GET_ACTIVE_APPLICATION",
    "OPEN_URL",
    "LIST_RECENT_PHOTOS",
    "SCHEDULE_MAC_NOTIFICATION",
    "CREATE_MAC_REMINDER",
    "LIST_MAC_REMINDERS",
    "COMPLETE_MAC_REMINDER",
  ],
  images: ["GENERATE_IMAGE"],
  studio: ["PUBLISH_REEL", "LIST_REELS", "GET_INSTAGRAM_STATS"],
  phone: ["SEND_SMS"],
  history: ["SEARCH_CONVERSATION_HISTORY", "CLEAR_CONVERSATION_HISTORY"],
  undo: ["UNDO_LAST_ACTION"],
  devices: ["LIST_DEVICES"],
};

const ALL_CLASSIFIED_TOOL_IDS = new Set<string>(Object.values(TOPIC_TOOL_IDS).flat());

/**
 * Dynamic Tool Scoping: returns the subset of `tools` reasonably relevant
 * to `message` (+ optional `recentContext`, e.g. the last user turn or two)
 * instead of always sending the full registry to the brain. Deliberately
 * conservative and rule-based (no AI call):
 *
 * - If zero topics or more than one topic is detected in the combined
 *   text, this returns the FULL tool list unchanged — a plain "hi"/"thanks"
 *   message and a genuinely multi-topic message ("what's the weather and
 *   what's on my calendar") both fall back to full exposure rather than
 *   risk guessing wrong. Uncertainty always resolves to "don't narrow."
 * - Otherwise, exactly one topic was detected: the result is the always-on
 *   core set, plus that topic's tools, plus every tool this module has no
 *   topic mapping for at all (an unclassified tool is never hidden — a
 *   false "tool not available" is worse than a slightly bloated list).
 *
 * This never adds a tool that wasn't already in `tools` and never changes
 * any tool's definition — it only ever narrows (or doesn't narrow) which
 * of the caller's already-registered tools get exposed to this one brain
 * call.
 */
export function scopeToolsForMessage(message: string, tools: readonly Tool[], recentContext?: string): Tool[] {
  const combinedText = recentContext ? `${message}\n${recentContext}` : message;
  const topics = classifyMessageTopics(combinedText);

  if (topics.size !== 1) {
    return [...tools];
  }

  const topic = topics.values().next().value as MessageTopic;
  const allowedIds = new Set<string>([...CORE_TOOL_IDS, ...(TOPIC_TOOL_IDS[topic] ?? [])]);

  return tools.filter((tool) => allowedIds.has(tool.id) || !ALL_CLASSIFIED_TOOL_IDS.has(tool.id));
}
