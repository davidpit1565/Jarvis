import { describe, test, expect } from "bun:test";
import {
  createSelfImprovementWatchSource,
  SELF_IMPROVEMENT_SOURCE_ID,
  type SelfImprovementCursor,
} from "@/watcher/selfImprovementWatchSource";
import { SELF_IMPROVEMENT_CANDIDATES } from "@/watcher/selfImprovementCandidates";

describe("selfImprovementCandidates", () => {
  test("is non-empty, bounded, and every candidate id is unique", () => {
    expect(SELF_IMPROVEMENT_CANDIDATES.length).toBeGreaterThan(0);
    expect(SELF_IMPROVEMENT_CANDIDATES.length).toBeLessThanOrEqual(12);
    const ids = SELF_IMPROVEMENT_CANDIDATES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("every candidate carries a non-empty what/how/why", () => {
    for (const candidate of SELF_IMPROVEMENT_CANDIDATES) {
      expect(candidate.title.length).toBeGreaterThan(0);
      expect(candidate.whatItIs.length).toBeGreaterThan(0);
      expect(candidate.howToImplement.length).toBeGreaterThan(0);
      expect(candidate.whyItMattersToDavid.length).toBeGreaterThan(0);
    }
  });
});

describe("createSelfImprovementWatchSource", () => {
  test("has a stable id and label", () => {
    const source = createSelfImprovementWatchSource();
    expect(source.id).toBe(SELF_IMPROVEMENT_SOURCE_ID);
    expect(source.label.length).toBeGreaterThan(0);
  });

  test("surfaces exactly one candidate on the very first poll (no baseline-only suppression)", async () => {
    const source = createSelfImprovementWatchSource();
    const { newItems, nextCursor } = await source.poll(undefined);

    expect(newItems).toHaveLength(1);
    expect(nextCursor.suggestedIds).toEqual([newItems[0]!.id]);
  });

  test("never surfaces more than one candidate per poll", async () => {
    const source = createSelfImprovementWatchSource();
    let cursor: SelfImprovementCursor | undefined = undefined;
    for (let i = 0; i < 20; i++) {
      const result = await source.poll(cursor);
      expect(result.newItems.length).toBeLessThanOrEqual(1);
      cursor = result.nextCursor;
    }
  });

  test("rotates candidates rather than repeating the same one every cycle", async () => {
    const source = createSelfImprovementWatchSource();
    const seen = new Set<string>();
    let cursor: SelfImprovementCursor | undefined = undefined;

    // Poll enough times to cycle through every candidate at least once.
    for (let i = 0; i < SELF_IMPROVEMENT_CANDIDATES.length; i++) {
      const { newItems, nextCursor } = await source.poll(cursor);
      expect(newItems).toHaveLength(1);
      seen.add(newItems[0]!.id);
      cursor = nextCursor;
    }

    expect(seen.size).toBe(SELF_IMPROVEMENT_CANDIDATES.length);
  });

  test("prefers a never-suggested candidate over re-suggesting a recent one", async () => {
    const source = createSelfImprovementWatchSource();
    const firstId = SELF_IMPROVEMENT_CANDIDATES[0]!.id;
    const cursor: SelfImprovementCursor = { suggestedIds: [firstId] };

    const { newItems } = await source.poll(cursor);
    expect(newItems[0]!.id).not.toBe(firstId);
  });

  test("does not immediately repeat the most recently suggested candidate once every candidate has been seen", async () => {
    const source = createSelfImprovementWatchSource();
    let cursor: SelfImprovementCursor | undefined = undefined;
    let lastId: string | undefined;

    for (let i = 0; i < SELF_IMPROVEMENT_CANDIDATES.length * 3; i++) {
      const { newItems, nextCursor } = await source.poll(cursor);
      const id = newItems[0]!.id;
      if (SELF_IMPROVEMENT_CANDIDATES.length > 1) {
        expect(id).not.toBe(lastId);
      }
      lastId = id;
      cursor = nextCursor;
    }
  });

  test("caps the remembered suggestion history rather than growing it unboundedly", async () => {
    const source = createSelfImprovementWatchSource();
    let cursor: SelfImprovementCursor | undefined = undefined;
    for (let i = 0; i < 200; i++) {
      const result = await source.poll(cursor);
      cursor = result.nextCursor;
    }
    expect(cursor!.suggestedIds.length).toBeLessThanOrEqual(50);
  });

  test("describe() returns the candidate's title", () => {
    const source = createSelfImprovementWatchSource();
    const candidate = SELF_IMPROVEMENT_CANDIDATES[0]!;
    expect(source.describe(candidate)).toBe(candidate.title);
  });
});
