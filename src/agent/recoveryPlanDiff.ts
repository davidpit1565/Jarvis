import type { AgentPlanStep, AgentStepProposal } from "./types";

/**
 * PR #157 audit finding #1: a RECOVERING replan's prompt (`priorFailureNote`
 * in `BrainAgentPlanner.plan`) only *tells* the model to avoid repeating its
 * mistake — nothing previously checked that the new plan actually does.
 * This module is that check: a cheap, deterministic comparison between the
 * step that just failed and the first step of a fresh recovery plan (the
 * one that would re-attempt that same point), with no LLM call involved —
 * see `AgentCore`'s PLANNING branch for where this gates the escalation in
 * `escalateRepeatedRecoveryFailure` instead of a new (possibly identical)
 * attempt.
 *
 * Deliberately narrow in scope: this only ever compares the failed step
 * against the new plan's *first* step, never the whole plan. Steps already
 * completed and verified are legitimately never re-proposed (see
 * `completedSteps` in `AgentPlanRequest`), so comparing against the whole
 * prior plan would produce false positives on every ordinary multi-step
 * recovery.
 */

/** How similar two step descriptions' word sets need to be (Jaccard similarity) to count as "near-identical" — see the module doc comment and this file's own tests for why 0.85 was chosen over something stricter/looser. */
export const DESCRIPTION_SIMILARITY_THRESHOLD = 0.85;

function normalizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/** Jaccard similarity (intersection over union) of two word lists, as sets. 0 when either is empty. */
function jaccardSimilarity(wordsA: string[], wordsB: string[]): number {
  const setA = new Set(wordsA);
  const setB = new Set(wordsB);
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const word of setA) {
    if (setB.has(word)) intersection++;
  }
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersection / union;
}

/**
 * True when two tool-call inputs are the same "idea" even if not byte-
 * identical — same set of keys, and each value equal once coerced to a
 * trimmed, lowercased string. Catches the common cosmetic differences a
 * model might introduce between two calls that are really the same
 * attempt (key order, incidental whitespace, `5` vs `"5"`) without a full
 * recursive/semantic diff, which this doesn't need: a genuinely different
 * attempt almost always changes a key, not just a value's formatting.
 */
function inputsAreNearIdentical(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keysA = Object.keys(a).sort();
  const keysB = Object.keys(b).sort();
  if (keysA.length !== keysB.length) return false;
  if (keysA.some((key, index) => key !== keysB[index])) return false;
  return keysA.every((key) => String(a[key]).trim().toLowerCase() === String(b[key]).trim().toLowerCase());
}

/**
 * Judges whether `nextProposal` — the first step of a freshly-produced
 * RECOVERING replan — is likely a repeat of `failedStep`, the step that
 * just failed and triggered that replan.
 *
 * Two signals, either of which is enough: (1) same tool, near-identical
 * input — the strongest evidence, since calling the same tool with
 * essentially the same arguments again *is* the same action regardless of
 * how its description is worded; (2) same tool, near-identical description
 * (word-set Jaccard similarity >= `DESCRIPTION_SIMILARITY_THRESHOLD`) —
 * a fuzzier backstop for when the input's shape changed cosmetically (e.g.
 * an added/renamed field that doesn't change what the step actually does)
 * but the plain-English description the model gave is clearly the same
 * idea reworded.
 *
 * Exact string equality on the description was deliberately rejected as
 * the bar — real planner output rephrases trivially between calls even
 * when genuinely retrying the same bad idea, which would make that check
 * useless; a normalized/fuzzy comparison is the point.
 */
export function isLikelySameRecoveryStep(failedStep: AgentPlanStep, nextProposal: AgentStepProposal): boolean {
  if (failedStep.toolName !== nextProposal.toolName) return false;
  if (inputsAreNearIdentical(failedStep.input, nextProposal.input)) return true;

  const similarity = jaccardSimilarity(normalizeWords(failedStep.description), normalizeWords(nextProposal.description));
  return similarity >= DESCRIPTION_SIMILARITY_THRESHOLD;
}
