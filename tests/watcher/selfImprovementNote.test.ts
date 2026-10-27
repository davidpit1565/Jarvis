import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { WatcherStore } from "@/watcher/WatcherStore";
import { selfImprovementNote } from "@/watcher/selfImprovementNote";
import { SELF_IMPROVEMENT_SOURCE_ID } from "@/watcher/selfImprovementWatchSource";
import { SELF_IMPROVEMENT_CANDIDATES, type SelfImprovementCandidate } from "@/watcher/selfImprovementCandidates";

describe("selfImprovementNote", () => {
  let store: WatcherStore;

  beforeEach(() => {
    store = new WatcherStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  test("returns undefined when nothing has been cached yet", () => {
    expect(selfImprovementNote(store)).toBeUndefined();
  });

  test("returns undefined when the latest poll found nothing new", () => {
    store.recordPoll(SELF_IMPROVEMENT_SOURCE_ID, { suggestedIds: [] }, []);
    expect(selfImprovementNote(store)).toBeUndefined();
  });

  test("ignores activity cached under an unrelated source id", () => {
    store.recordPoll("unrelated-source", undefined, [SELF_IMPROVEMENT_CANDIDATES[0]]);
    expect(selfImprovementNote(store)).toBeUndefined();
  });

  test("includes the candidate's title, what/how/why, and the don't-repeat/email instructions", () => {
    const candidate: SelfImprovementCandidate = SELF_IMPROVEMENT_CANDIDATES[0]!;
    store.recordPoll(SELF_IMPROVEMENT_SOURCE_ID, { suggestedIds: [candidate.id] }, [candidate]);

    const note = selfImprovementNote(store)!;
    expect(note).toBeDefined();
    expect(note).toContain(candidate.title);
    expect(note).toContain(candidate.whatItIs);
    expect(note).toContain(candidate.howToImplement);
    expect(note).toContain(candidate.whyItMattersToDavid);
    expect(note).toMatch(/do NOT bring this up again/i);
    expect(note).toContain("SEND_EMAIL");
  });
});
