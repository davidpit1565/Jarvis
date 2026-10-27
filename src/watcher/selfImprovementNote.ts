import type { WatcherStore } from "@/watcher/WatcherStore";
import type { SelfImprovementCandidate } from "@/watcher/selfImprovementCandidates";
import { SELF_IMPROVEMENT_SOURCE_ID } from "@/watcher/selfImprovementWatchSource";

/**
 * Composes the self-improvement suggestion note from whatever
 * `createSelfImprovementWatchSource`'s poller most recently cached.
 *
 * Deliberately NOT built on `composeWatcherNote` (same reasoning
 * `githubActivityNote.ts` already gives for not reusing it): that composer
 * is tuned for potentially several sources each with potentially several
 * short, flat item descriptions ("- label — N new item(s): desc, desc").
 * This source only ever surfaces exactly one item at a time, but that one
 * item needs to carry real substance (what it is, how to build it, why it
 * matters) for two reasons this task specifically calls for: (1) the model
 * needs enough to phrase a genuine, specific-sounding suggestion rather than
 * a vague one-liner, and (2) if David says "email me that," the model needs
 * the actual content available to compose into `SEND_EMAIL`'s body — a
 * single quoted title would not be enough for either.
 */
export function selfImprovementNote(store: WatcherStore): string | undefined {
  const record = store.listWithActivity<SelfImprovementCandidate>().find((r) => r.sourceId === SELF_IMPROVEMENT_SOURCE_ID);
  if (!record || record.newItems.length === 0) return undefined;

  // This source's own poll() never returns more than one item at a time —
  // see createSelfImprovementWatchSource's doc comment — so there is
  // nothing to cap/bound here the way other notes in this codebase do.
  const candidate = record.newItems[0]!;

  return (
    `JARVIS has one self-improvement idea it hasn't mentioned to David yet (do NOT bring this up again if he's ` +
    `already said no or let a past suggestion pass without interest — only offer this one once, and only if it ` +
    `fits naturally): "${candidate.title}". ` +
    `What it is: ${candidate.whatItIs} ` +
    `How it could be built: ${candidate.howToImplement} ` +
    `Why it might matter to David: ${candidate.whyItMattersToDavid} ` +
    `Offer it like a thoughtful assistant sharing an idea ("I noticed X — want me to look into building that?"), ` +
    `never as asking permission to do your job and never as a sales pitch. If he asks to have it emailed, use ` +
    `SEND_EMAIL with this same content.`
  );
}
