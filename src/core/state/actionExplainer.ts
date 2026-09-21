import type { ConversationMessage } from "@/types/conversation";

/**
 * "Why did you do that?" (JARVIS_ROADMAP_AUDIT.md Premium Agent Intelligence
 * Upgrade, batch 4, item 3) — a safe, one-sentence explanation of the most
 * recent tool call this conversation made, composed deterministically from
 * two already-known real facts:
 *
 *   1. `triggeringMessage` — the user message that started the turn in
 *      which the tool was called (already sitting in conversation history,
 *      nothing new tracked for this).
 *   2. `toolName` — the tool that actually ran (from that turn's assistant
 *      message, already recorded).
 *
 * Deliberately mirrors `liveStatusFormatter`'s own house style: no LLM
 * call, no fabricated causal story beyond what these two real facts
 * support — never anything like "because I judged it was important",
 * which would be an invented reason, not a real one.
 */

export interface LastToolCall {
  toolName: string;
  /** The user message that started the turn this tool call belongs to, or "" if none was found (shouldn't normally happen, but handled honestly rather than guessed at). */
  triggeringMessage: string;
}

/**
 * Scans `messages` (as returned by `ConversationManager.getMessages()`,
 * oldest first) backward for the most recent assistant message that made
 * at least one tool call, then backward again from there for the nearest
 * preceding user message — the message that started that same turn (a
 * turn always begins with exactly one `addUserMessage` call). Returns
 * `null` if no tool call has been made in this conversation at all, so
 * callers can give an honest "I haven't done anything to explain yet"
 * instead of inventing one.
 */
export function findLastToolCall(messages: ConversationMessage[]): LastToolCall | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role !== "assistant" || !message.toolCalls || message.toolCalls.length === 0) continue;

    const toolName = message.toolCalls[message.toolCalls.length - 1]!.toolName;
    for (let j = i - 1; j >= 0; j--) {
      const prior = messages[j]!;
      if (prior.role === "user") {
        return { toolName, triggeringMessage: prior.content };
      }
    }
    return { toolName, triggeringMessage: "" };
  }
  return null;
}

/** Turns a snake_case tool registry name into a plain, readable phrase — a purely mechanical transform, never a guess at what the tool "really" does. */
function humanizeToolName(toolName: string): string {
  return toolName.replace(/_/g, " ").trim();
}

/**
 * Composes the one-sentence "why did you do that" answer. When
 * `triggeringMessage` is empty (no user message could be found for that
 * turn), falls back to a still-honest, slightly more generic sentence
 * rather than fabricating a quoted request that was never actually said.
 */
export function explainAction(toolName: string, triggeringMessage: string, language: "en" | "he" = "en"): string {
  const readableTool = humanizeToolName(toolName);
  if (language === "he") {
    return triggeringMessage
      ? `ביקשת ממני "${triggeringMessage}", אז השתמשתי ב-${readableTool} כדי לעזור עם זה.`
      : `השתמשתי ב-${readableTool} כדי לעזור עם הבקשה שלך.`;
  }
  return triggeringMessage
    ? `You asked me to "${triggeringMessage}", so I used ${readableTool} to help with that.`
    : `I used ${readableTool} to help with your request.`;
}

const NO_ACTION_YET: Record<"en" | "he", string> = {
  en: "I haven't done anything to explain yet.",
  he: "עדיין לא עשיתי כלום שיש להסביר.",
};

/** The honest reply when `findLastToolCall` found nothing to explain — never invented. */
export function noActionToExplain(language: "en" | "he" = "en"): string {
  return NO_ACTION_YET[language];
}

function normalize(message: string): string {
  return message.trim().toLowerCase().replace(/[?!.]+$/, "").replace(/\s+/g, " ");
}

/**
 * A small, literal-ish set of "why did you do that?" / "why did you check
 * X?" phrases (English and Hebrew), same conservatism as
 * `liveStatusFormatter`'s `isLikelyStatusQuery` and
 * `FastPathClassifier`'s rules: deliberately narrow, biased toward `false`
 * (fall through to the normal full path) rather than guessing at intent
 * from arbitrary phrasing.
 */
const WHY_QUERY_PATTERNS: RegExp[] = [
  /^why did you do (that|this|it)$/,
  /^why (did|would) you do (that|this|it)$/,
  /^why did you (check|use|run|call) (my |the )?[a-z0-9_' ]+$/,
  /^why (did|would) you (check|use|run|call) (my |the )?[a-z0-9_' ]+$/,
  /^why$/,
  /^למה עשית (את )?זה$/,
  /^למה בדקת (את )?(ה)?[א-ת0-9' ]+$/,
  /^למה השתמשת ב[א-ת0-9' ]+$/,
  /^למה הרצת (את )?[א-ת0-9' ]+$/,
];

export function isLikelyWhyQuery(text: string): boolean {
  const normalized = normalize(text);
  if (!normalized) return false;
  return WHY_QUERY_PATTERNS.some((pattern) => pattern.test(normalized));
}
