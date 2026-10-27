import type { BehaviorCorrectionStore } from "@/behavior/BehaviorCorrectionStore";
import { classifyMessageTopics, type MessageTopic } from "@/core/intent/MessageTopics";
import { TOPIC_TOOL_IDS } from "@/core/intent/ToolScoping";

/**
 * Correction Learning's surfacing half (CLAUDE.md task spec point 3): turns
 * stored behavioral corrections into a system-prompt note, the same
 * composition pattern as `goalProgressNote.ts`/`staleCommitmentsNote.ts` —
 * but, unlike those two (which are always shown, capped), this one is
 * relevance-gated, matching the task's explicit instruction to look at how
 * `ToolScoping.ts` filters by topic rather than dumping every stored
 * correction into every prompt.
 *
 * How relevance is decided: reuses the exact same deterministic topic
 * classification `ToolScoping.ts` already uses to narrow the tool list
 * (`classifyMessageTopics` + `TOPIC_TOOL_IDS`) — a correction is only ever
 * considered relevant when the current message maps to EXACTLY ONE topic,
 * and only corrections filed under that topic's tool ids are surfaced.
 *
 * Two cases deliberately return nothing, both conservative-by-design:
 *   - Zero or multiple topics detected (an ambiguous or multi-topic
 *     message) — `ToolScoping` resolves this by NOT narrowing (showing
 *     every tool), but a note injected into every prompt is a cost/dilution
 *     concern a tool list isn't, so here "can't tell what's relevant" means
 *     "show nothing" rather than "show everything stored" — the same
 *     unbounded-growth failure mode the Goal Engine audit already flagged
 *     and capped for goals, just approached from the gating side instead of
 *     a retrieval cap.
 *   - No corrections stored under that topic's tool ids at all.
 *
 * A flagged preference-conflict correction (see BehaviorCorrectionRecord's
 * doc comment) is never silently presented as settled guidance — it's
 * called out with an explicit caveat instead, so the standing preference
 * still wins unless/until the user actually confirms the correction.
 */
function contextKeysForMessage(message: string): string[] {
  const topics = classifyMessageTopics(message);
  if (topics.size !== 1) return [];
  const topic = topics.values().next().value as MessageTopic;
  return [...(TOPIC_TOOL_IDS[topic] ?? [])];
}

export function correctionNote(store: BehaviorCorrectionStore, message: string): string | undefined {
  const contextKeys = contextKeysForMessage(message);
  if (contextKeys.length === 0) return undefined;

  const corrections = store.listRelevant(contextKeys);
  if (corrections.length === 0) return undefined;

  const lines = corrections.map((correction) => {
    const caveat = correction.flaggedPreferenceConflict
      ? ` (NOTE: this may conflict with a standing preference already on record${
          correction.conflictingPreference ? ` — "${correction.conflictingPreference}"` : ""
        }; a single past correction doesn't override an explicit standing preference, so check before assuming this wins)`
      : "";
    return `- ${correction.correction}${caveat}`;
  });

  return (
    "The user has corrected JARVIS's behavior in this area before — keep these in mind if relevant to what " +
    `you're about to do (do not treat them as absolute rules that override an explicit instruction given right now):\n${lines.join("\n")}`
  );
}
