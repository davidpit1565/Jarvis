import type { WatchSource } from "@/watcher/WatchSource";
import { SELF_IMPROVEMENT_CANDIDATES, type SelfImprovementCandidate } from "@/watcher/selfImprovementCandidates";

/** Stable id for this single, always-on-the-same-id source — see WatcherChannelRouter's `alwaysQuietSourceIds` for why this exact id matters (it's pinned to the quiet channel by id, not by any env-configurable rule). */
export const SELF_IMPROVEMENT_SOURCE_ID = "self-improvement";

/**
 * How many past suggestions the cursor remembers for rotation purposes —
 * bounded so the cursor itself never grows unboundedly (same discipline
 * `newsWatchSources.ts`'s `SEEN_LINKS_CURSOR_CAP` already follows). This
 * only needs to comfortably exceed `SELF_IMPROVEMENT_CANDIDATES.length` for
 * the rotation logic below to always prefer whatever hasn't been suggested
 * in the longest time.
 */
const MAX_HISTORY = 50;

export interface SelfImprovementCursor {
  /** Candidate ids already surfaced, oldest first — used only to rotate away from recently-suggested ones, never replayed as "new" activity. */
  suggestedIds: string[];
}

/**
 * Picks the single best candidate to surface next: whichever one was
 * suggested longest ago, with a candidate never suggested at all always
 * preferred over one that has been (an "infinitely long ago" case). This is
 * a plain round-robin-by-recency, not a model judgment call — deliberately,
 * per CLAUDE.md's Proactive Watcher philosophy ("not JARVIS deciding
 * unilaterally"): which candidate to show next is a mechanical rotation
 * rule, not something the model gets to pick in the moment.
 */
function pickNextCandidate(history: string[]): SelfImprovementCandidate | undefined {
  if (SELF_IMPROVEMENT_CANDIDATES.length === 0) return undefined;

  const reversedHistory = [...history].reverse();
  let best: SelfImprovementCandidate | undefined;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const candidate of SELF_IMPROVEMENT_CANDIDATES) {
    // Index counting from the end of history: 0 = suggested most recently
    // (least preferred — lowest score), a larger index = suggested longer
    // ago (more preferred — higher score). Never-suggested beats
    // everything, scored as +Infinity.
    const idxFromEnd = reversedHistory.indexOf(candidate.id);
    const score = idxFromEnd === -1 ? Number.POSITIVE_INFINITY : idxFromEnd;
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best;
}

/**
 * The self-improvement suggestion source for the generalized Proactive
 * Watcher (`CLAUDE.md`'s "build the self-improvement suggestion engine"
 * follow-up item). Draws from the curated, bounded
 * `SELF_IMPROVEMENT_CANDIDATES` list — never an open-ended "ask an LLM to
 * brainstorm improvements" prompt (see that file's own doc comment for why)
 * — and surfaces exactly one candidate per poll cycle, prioritizing
 * whichever hasn't been suggested in the longest time, so a weekly-scale
 * poll interval naturally means David sees a steady trickle of distinct
 * ideas rather than the same one repeated or a flood of several at once.
 *
 * **Deliberately does NOT follow the "first poll establishes a baseline,
 * reports nothing as new" convention most other `WatchSource`s here use**
 * (see `WatchSource.poll`'s own doc comment for that convention). That
 * convention exists specifically to avoid reporting an entire pre-existing
 * backlog as a fabricated burst of "new" activity (e.g. every commit a repo
 * has ever had, or every headline currently in a feed) the very first time
 * a source is polled. This source never reports more than exactly one item
 * per poll, on any poll including the first — there is no backlog to dump,
 * so suppressing the first poll's candidate would only delay the feature by
 * one full poll interval (on the default weekly cadence, a full week) for
 * no corresponding safety benefit.
 */
export function createSelfImprovementWatchSource(): WatchSource<SelfImprovementCursor, SelfImprovementCandidate> {
  return {
    id: SELF_IMPROVEMENT_SOURCE_ID,
    label: "JARVIS self-improvement ideas",

    async poll(previousCursor) {
      const history = previousCursor?.suggestedIds ?? [];
      const candidate = pickNextCandidate(history);
      if (!candidate) {
        return { newItems: [], nextCursor: { suggestedIds: history } };
      }
      const nextHistory = [...history, candidate.id].slice(-MAX_HISTORY);
      return { newItems: [candidate], nextCursor: { suggestedIds: nextHistory } };
    },

    describe(item) {
      return item.title;
    },
  };
}
