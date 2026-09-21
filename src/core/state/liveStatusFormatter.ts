import type { LiveStateSnapshot, LiveState, LiveLanguage } from "./JarvisLiveState";

/**
 * Extra real context a caller may have on hand that `LiveStateSnapshot`
 * itself doesn't carry (it's deliberately generic — see its own doc
 * comment) — e.g. `AgentCore` knows a task's `goal` and its plan's current
 * `toolName`, which make for a much more specific answer than the bare
 * live state alone. Both optional: the formatter still produces a correct,
 * honest sentence from `snapshot` alone when neither is known.
 */
export interface LiveStatusContext {
  /** The autonomous task's goal, if this session's activity is driven by one (see AgentTaskRecord.goal). */
  goal?: string;
  /** The tool currently running or most recently run, if known. */
  currentTool?: string;
}

/**
 * Deterministically composes a real, one/two-sentence "what are you doing
 * right now?" answer from an actual `LiveStateSnapshot` — never a canned
 * "I'm working on it" and never an LLM call: every field it uses (`state`,
 * `reason`, `language`, plus the optional `goal`/`currentTool` context) is
 * real, already-tracked data. Renders English or Hebrew depending on
 * `snapshot.language` (falls back to English when unset, since the JARVIS
 * system prompt's own reply-language default is English until a turn's
 * language is actually detected).
 *
 * Deliberately scoped to just the formatter, not full request routing —
 * `Orchestrator.handleUserMessage` has no existing fast-path hook for
 * literal status-query phrases today (every message goes straight to the
 * Brain), and bolting one on here would be exactly the kind of hacky,
 * un-owned wiring this upgrade's scope explicitly warns against. Wiring
 * this in as a real fast-path is a deliberate, scoped-out follow-up — see
 * `isLikelyStatusQuery` below for the literal-phrase matcher a future
 * integration would use.
 */
export function formatLiveStatus(snapshot: LiveStateSnapshot, context: LiveStatusContext = {}): string {
  const language: LiveLanguage = snapshot.language ?? "en";
  return language === "he" ? formatHebrew(snapshot, context) : formatEnglish(snapshot, context);
}

function formatEnglish(snapshot: LiveStateSnapshot, context: LiveStatusContext): string {
  const { state, reason } = snapshot;
  const goalClause = context.goal ? ` My current goal is: "${context.goal}."` : "";
  const toolClause = context.currentTool ? ` I'm currently using ${context.currentTool}.` : "";

  switch (state) {
    case "IDLE":
      return "I'm not doing anything right now — just waiting for you.";
    case "LISTENING":
      return "I'm listening to your message.";
    case "THINKING":
      return `I'm thinking about how to respond.${goalClause}`;
    case "PLANNING":
      return `I'm planning out the steps for this task.${goalClause}`;
    case "EXECUTING":
      return `I'm actively working on it.${toolClause}${goalClause}${reason ? ` (${reason})` : ""}`;
    case "VERIFYING":
      return `I'm verifying the result of the last step I ran.${goalClause}`;
    case "WAITING":
      return reason ? `I'm waiting — ${reason}.` : "I'm waiting on something before I can continue.";
    case "SPEAKING":
      return "I'm putting together my reply.";
    case "ERROR":
      return reason ? `I ran into a problem: ${reason}. I've reset and I'm ready for your next message.` : "I ran into a problem, but I've reset and I'm ready for your next message.";
    case "STOPPED":
      return "I stopped what I was doing, like you asked.";
    default:
      return describeUnknownState(state);
  }
}

function formatHebrew(snapshot: LiveStateSnapshot, context: LiveStatusContext): string {
  const { state, reason } = snapshot;
  const goalClause = context.goal ? ` המטרה הנוכחית שלי היא: "${context.goal}".` : "";
  const toolClause = context.currentTool ? ` אני כרגע משתמש ב-${context.currentTool}.` : "";

  switch (state) {
    case "IDLE":
      return "אני לא עושה כלום כרגע — פשוט מחכה לך.";
    case "LISTENING":
      return "אני מקשיב להודעה שלך.";
    case "THINKING":
      return `אני חושב איך להגיב.${goalClause}`;
    case "PLANNING":
      return `אני מתכנן את השלבים למשימה הזו.${goalClause}`;
    case "EXECUTING":
      return `אני עובד על זה כרגע.${toolClause}${goalClause}${reason ? ` (${reason})` : ""}`;
    case "VERIFYING":
      return `אני מוודא את התוצאה של השלב האחרון שהרצתי.${goalClause}`;
    case "WAITING":
      return reason ? `אני ממתין — ${reason}.` : "אני ממתין למשהו לפני שאני יכול להמשיך.";
    case "SPEAKING":
      return "אני מנסח את התשובה שלי.";
    case "ERROR":
      return reason ? `נתקלתי בבעיה: ${reason}. אני מאופס ומוכן להודעה הבאה שלך.` : "נתקלתי בבעיה, אבל אני מאופס ומוכן להודעה הבאה שלך.";
    case "STOPPED":
      return "עצרתי את מה שעשיתי, כמו שביקשת.";
    default:
      return describeUnknownState(state);
  }
}

/** Defensive fallback only — every real `LiveState` is handled explicitly above; this exists so an exhaustiveness gap fails loudly instead of silently returning nothing. */
function describeUnknownState(state: LiveState): string {
  return `Current state: ${state}.`;
}

/**
 * A small, literal set of "what are you doing?" phrases (English and
 * Hebrew) this formatter is meant to answer, for a future fast-path
 * integration into `Orchestrator.handleUserMessage` — not wired in here
 * (see `formatLiveStatus`'s doc comment for why). Deliberately narrow: this
 * is a fast-path match, not NLU, so it only recognizes near-exact phrasing
 * rather than guessing at intent from arbitrary text.
 */
const STATUS_QUERY_PHRASES = [
  "what are you doing",
  "what are you doing right now",
  "what are you doing?",
  "מה אתה עושה",
  "מה אתה עושה עכשיו",
  "מה אתה עושה?",
];

export function isLikelyStatusQuery(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return STATUS_QUERY_PHRASES.some((phrase) => normalized === phrase.toLowerCase());
}
