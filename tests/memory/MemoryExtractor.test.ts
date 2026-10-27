import { describe, test, expect } from "bun:test";
import { MemoryExtractor } from "@/memory/MemoryExtractor";
import { MemoryStore } from "@/memory/MemoryStore";
import { BehaviorCorrectionStore } from "@/behavior/BehaviorCorrectionStore";
import { EventBus } from "@/core/events/EventBus";
import type { Brain, BrainRequest, BrainResponse } from "@/types/brain";

/** A Brain that returns queued responses in order, or a scripted delay/failure — no network calls. */
class ScriptedBrain implements Brain {
  private calls = 0;
  requests: BrainRequest[] = [];
  constructor(private readonly responses: Array<BrainResponse | Error | "hang">) {}

  async chat(request: BrainRequest): Promise<BrainResponse> {
    this.requests.push(request);
    const response = this.responses[this.calls];
    this.calls++;
    if (response === undefined) throw new Error("ScriptedBrain ran out of responses");
    if (response === "hang") return new Promise<BrainResponse>(() => {}); // never resolves
    if (response instanceof Error) throw response;
    return response;
  }
}

function jsonResponse(text: string): BrainResponse {
  return { text, toolCalls: [], stopReason: "end_turn" };
}

/** Waits for the microtask/timer queue to drain so a fire-and-forget extractAndStore() call has a chance to finish. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

describe("MemoryExtractor", () => {
  test("extracts and writes a new fact, categorized and sourced as BACKGROUND_INFERRED", async () => {
    const store = new MemoryStore(":memory:");
    const brain = new ScriptedBrain([
      jsonResponse(
        '[{"key":"user.hobby.piano","value":"plays classical piano, likes Chopin","category":"fact","importance":3,"confidence":0.9}]'
      ),
    ]);
    const extractor = new MemoryExtractor(brain, store);

    extractor.extractAndStore("user-1", "I play piano, mostly classical, I love Chopin", "That's wonderful, sir.");
    await flush();

    const record = store.getByKey("user.hobby.piano");
    expect(record?.value).toBe("plays classical piano, likes Chopin");
    expect(record?.category).toBe("fact");
    expect(record?.source).toBe("BACKGROUND_INFERRED");
    expect(record?.confidence).toBe(0.9);
    store.close();
  });

  test("the extraction call uses a focused prompt and no tools — not the full conversation/system prompt", async () => {
    const store = new MemoryStore(":memory:");
    const brain = new ScriptedBrain([jsonResponse("[]")]);
    const extractor = new MemoryExtractor(brain, store);

    extractor.extractAndStore("user-1", "hello", "hi there");
    await flush();

    expect(brain.requests).toHaveLength(1);
    expect(brain.requests[0]?.tools).toEqual([]);
    expect(brain.requests[0]?.messages).toHaveLength(1);
    expect(brain.requests[0]?.taskType).toBe("memory-extraction");
    store.close();
  });

  test("updates/supersedes a near-duplicate existing fact in the same category instead of creating a new row", async () => {
    const store = new MemoryStore(":memory:");
    store.save({
      key: "user.hobby.piano",
      value: "David plays piano, classical style",
      category: "fact",
      source: "USER_STATED",
    });
    const brain = new ScriptedBrain([
      jsonResponse(
        '[{"key":"user.piano.fact","value":"David plays piano classical style","category":"fact","confidence":0.8}]'
      ),
    ]);
    const extractor = new MemoryExtractor(brain, store);

    extractor.extractAndStore("user-1", "yeah I still play piano, classical style", "Good to know, sir.");
    await flush();

    // Reused the EXISTING key (lexical near-duplicate), not a new one.
    expect(store.getByKey("user.piano.fact")).toBeNull();
    const all = store.search("piano");
    expect(all).toHaveLength(1);
    expect(all[0]?.key).toBe("user.hobby.piano");
    store.close();
  });

  test("an explicit user deletion is not undone by a later extraction pass that still sees the old fact in raw text", async () => {
    const store = new MemoryStore(":memory:");
    store.save({ key: "user.hobby.piano", value: "plays piano", category: "fact", source: "USER_STATED" });
    store.deleteByKey("user.hobby.piano");

    const brain = new ScriptedBrain([
      jsonResponse('[{"key":"user.hobby.piano","value":"plays piano","category":"fact","confidence":0.9}]'),
    ]);
    const extractor = new MemoryExtractor(brain, store);

    // The raw exchange text still mentions the deleted fact (e.g. the user
    // is talking ABOUT having quit piano) — extraction must not resurrect it.
    extractor.extractAndStore("user-1", "yeah I used to play piano", "Understood, sir.");
    await flush();

    expect(store.getByKey("user.hobby.piano")).toBeNull();
    store.close();
  });

  test("a BACKGROUND_INFERRED write can never overwrite an existing higher-trust (USER_STATED) fact for the same key", async () => {
    const store = new MemoryStore(":memory:");
    store.save({ key: "user.job", value: "Software Engineer at Acme", source: "USER_STATED" });

    const brain = new ScriptedBrain([
      jsonResponse('[{"key":"user.job","value":"guessing: works in tech","category":"fact","confidence":0.3}]'),
    ]);
    const extractor = new MemoryExtractor(brain, store);

    extractor.extractAndStore("user-1", "something ambiguous about work", "Noted, sir.");
    await flush();

    expect(store.getByKey("user.job")?.value).toBe("Software Engineer at Acme");
    store.close();
  });

  test("a brain failure never throws out of extractAndStore and never writes anything", async () => {
    const store = new MemoryStore(":memory:");
    const brain = new ScriptedBrain([new Error("provider unavailable")]);
    const extractor = new MemoryExtractor(brain, store);

    expect(() => extractor.extractAndStore("user-1", "hello", "hi")).not.toThrow();
    await flush();

    expect(store.getActive()).toEqual([]);
    store.close();
  });

  test("extractAndStore returns immediately without waiting for the brain call (fire-and-forget)", async () => {
    const store = new MemoryStore(":memory:");
    const brain = new ScriptedBrain(["hang"]); // never resolves
    const extractor = new MemoryExtractor(brain, store);

    const start = Date.now();
    extractor.extractAndStore("user-1", "hello", "hi");
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(50); // did not await the hanging brain call
    store.close();
  });

  test("malformed JSON from the brain is ignored, not thrown", async () => {
    const store = new MemoryStore(":memory:");
    const brain = new ScriptedBrain([jsonResponse("not valid json at all")]);
    const extractor = new MemoryExtractor(brain, store);

    extractor.extractAndStore("user-1", "hello", "hi");
    await flush();

    expect(store.getActive()).toEqual([]);
    store.close();
  });

  test("an empty extraction result ('[]') writes nothing", async () => {
    const store = new MemoryStore(":memory:");
    const brain = new ScriptedBrain([jsonResponse("[]")]);
    const extractor = new MemoryExtractor(brain, store);

    extractor.extractAndStore("user-1", "just chatting, nothing notable", "Indeed, sir.");
    await flush();

    expect(store.getActive()).toEqual([]);
    store.close();
  });

  test("skips the brain call entirely when both sides of the exchange are empty", async () => {
    const store = new MemoryStore(":memory:");
    const brain = new ScriptedBrain([jsonResponse("[]")]);
    const extractor = new MemoryExtractor(brain, store);

    extractor.extractAndStore("user-1", "", "");
    await flush();

    expect(brain.requests).toHaveLength(0);
    store.close();
  });

  test("emits a memory.extraction.failed event (not a throw) when the brain call fails", async () => {
    const store = new MemoryStore(":memory:");
    const brain = new ScriptedBrain([new Error("provider down")]);
    const eventBus = new EventBus();
    const events: unknown[] = [];
    eventBus.on("memory.extraction.failed", (payload) => events.push(payload));
    const extractor = new MemoryExtractor(brain, store, eventBus);

    extractor.extractAndStore("user-1", "hello", "hi");
    await flush();

    expect(events).toHaveLength(1);
    store.close();
  });

  describe("Correction Learning (behavioral corrections)", () => {
    test("detects a behavioral correction and files it under the prior action's tool name, not when no priorAction is given", async () => {
      const store = new MemoryStore(":memory:");
      const corrections = new BehaviorCorrectionStore(":memory:");
      const brain = new ScriptedBrain([
        jsonResponse(
          '[{"type":"correction","correction":"ask for a specific time instead of assuming morning","confidence":0.85,"conflictsWithStandingPreference":false}]'
        ),
      ]);
      const extractor = new MemoryExtractor(brain, store, undefined, corrections);

      extractor.extractAndStore("user-1", "no, I meant 6pm, not 6am", "Got it, sir — rescheduled for 6pm.", {
        toolName: "CREATE_REMINDER",
        triggeringMessage: "remind me tomorrow",
      });
      await flush();

      const filed = corrections.listForContext("CREATE_REMINDER");
      expect(filed).toHaveLength(1);
      expect(filed[0]?.correction).toBe("ask for a specific time instead of assuming morning");
      expect(filed[0]?.source).toBe("BACKGROUND_INFERRED");
      expect(filed[0]?.confidence).toBe(0.85);
      expect(filed[0]?.flaggedPreferenceConflict).toBe(false);
      store.close();
      corrections.close();
    });

    test("the extraction prompt includes the prior action only when priorAction is supplied", async () => {
      const store = new MemoryStore(":memory:");
      const brain = new ScriptedBrain([jsonResponse("[]"), jsonResponse("[]")]);
      const extractor = new MemoryExtractor(brain, store);

      extractor.extractAndStore("user-1", "hello", "hi there");
      await flush();
      extractor.extractAndStore("user-1", "no, not like that", "Understood, sir.", {
        toolName: "SEND_EMAIL",
        triggeringMessage: "email the team",
      });
      await flush();

      expect(brain.requests[0]?.context).not.toContain("SEND_EMAIL");
      expect(brain.requests[1]?.context).toContain("SEND_EMAIL");
      store.close();
    });

    test("does NOT fire a correction for a plain fact statement with no bearing on the prior action", async () => {
      const store = new MemoryStore(":memory:");
      const corrections = new BehaviorCorrectionStore(":memory:");
      const brain = new ScriptedBrain([
        jsonResponse('[{"key":"user.hobby.piano","value":"plays piano","category":"fact","confidence":0.9}]'),
      ]);
      const extractor = new MemoryExtractor(brain, store, undefined, corrections);

      extractor.extractAndStore("user-1", "by the way, I play piano", "Nice, sir.", {
        toolName: "CREATE_REMINDER",
        triggeringMessage: "remind me tomorrow",
      });
      await flush();

      expect(corrections.listForContext("CREATE_REMINDER")).toHaveLength(0);
      expect(store.getByKey("user.hobby.piano")).not.toBeNull();
      store.close();
      corrections.close();
    });

    test("does NOT fire a correction for a simple factual correction (the fact-extraction path's job, not this one's)", async () => {
      const store = new MemoryStore(":memory:");
      const corrections = new BehaviorCorrectionStore(":memory:");
      // A plain factual correction is expected to come back as a fact entry
      // (the corrected value), never a "correction"-type entry — this
      // scripted response models exactly that expected, correct behavior.
      const brain = new ScriptedBrain([
        jsonResponse('[{"key":"user.timezone","value":"America/New_York","category":"fact","confidence":0.9}]'),
      ]);
      const extractor = new MemoryExtractor(brain, store, undefined, corrections);

      extractor.extractAndStore("user-1", "actually my timezone is New York, not LA", "Updated, sir.", {
        toolName: "CREATE_CALENDAR_EVENT",
        triggeringMessage: "schedule my meeting",
      });
      await flush();

      expect(corrections.listForContext("CREATE_CALENDAR_EVENT")).toHaveLength(0);
      expect(store.getByKey("user.timezone")?.value).toBe("America/New_York");
      store.close();
      corrections.close();
    });

    test("a correction is simply not written when no correctionStore was configured, even if detected", async () => {
      const store = new MemoryStore(":memory:");
      const brain = new ScriptedBrain([jsonResponse('[{"type":"correction","correction":"do X differently"}]')]);
      const extractor = new MemoryExtractor(brain, store); // no correctionStore

      expect(() =>
        extractor.extractAndStore("user-1", "no, not like that", "Noted, sir.", {
          toolName: "CREATE_REMINDER",
          triggeringMessage: "remind me",
        })
      ).not.toThrow();
      await flush();

      store.close();
    });

    test("guardrail: a correction flagged by the model as conflicting with a standing preference is stored but marked, not silently applied", async () => {
      const store = new MemoryStore(":memory:");
      store.save({
        key: "user.email.cc_policy",
        value: "never cc anyone on my emails without asking first",
        category: "preference",
        source: "USER_STATED",
      });
      const corrections = new BehaviorCorrectionStore(":memory:");
      const brain = new ScriptedBrain([
        jsonResponse(
          '[{"type":"correction","correction":"always cc my assistant on outgoing emails","confidence":0.7,"conflictsWithStandingPreference":true,"conflictingPreferenceText":"never cc anyone on my emails without asking first"}]'
        ),
      ]);
      const extractor = new MemoryExtractor(brain, store, undefined, corrections);

      extractor.extractAndStore("user-1", "cc my assistant on that from now on", "Okay, sir.", {
        toolName: "SEND_EMAIL",
        triggeringMessage: "send that email",
      });
      await flush();

      // The preference list was actually fed into the prompt, so the model
      // call had what it needed to make this judgment.
      expect(brain.requests[0]?.context).toContain("never cc anyone on my emails without asking first");

      const filed = corrections.listForContext("SEND_EMAIL");
      expect(filed).toHaveLength(1);
      expect(filed[0]?.flaggedPreferenceConflict).toBe(true);
      expect(filed[0]?.conflictingPreference).toBe("never cc anyone on my emails without asking first");

      // The standing preference itself is untouched — never overwritten by the correction.
      expect(store.getByKey("user.email.cc_policy")?.value).toBe("never cc anyone on my emails without asking first");
      store.close();
      corrections.close();
    });

    test("emits a behaviorCorrection.stored event with the flagged-conflict state", async () => {
      const store = new MemoryStore(":memory:");
      const corrections = new BehaviorCorrectionStore(":memory:");
      const eventBus = new EventBus();
      const events: unknown[] = [];
      eventBus.on("behaviorCorrection.stored", (payload) => events.push(payload));
      const brain = new ScriptedBrain([
        jsonResponse('[{"type":"correction","correction":"do X differently","confidence":0.6}]'),
      ]);
      const extractor = new MemoryExtractor(brain, store, eventBus, corrections);

      extractor.extractAndStore("user-1", "no, not like that", "Noted, sir.", {
        toolName: "CREATE_REMINDER",
        triggeringMessage: "remind me",
      });
      await flush();

      expect(events).toEqual([{ contextKey: "CREATE_REMINDER", flaggedPreferenceConflict: false }]);
      store.close();
      corrections.close();
    });
  });

  describe("Scoped Fact-Consolidation (semantic update check, 2026-10-27)", () => {
    test("baseline: a totally unrelated new fact is unaffected when existing memories are present", async () => {
      const store = new MemoryStore(":memory:");
      store.save({ key: "user.location", value: "lives in Haifa", category: "fact", source: "USER_STATED" });
      const brain = new ScriptedBrain([
        jsonResponse('[{"key":"user.hobby.piano","value":"plays classical piano","category":"fact","confidence":0.9}]'),
      ]);
      const extractor = new MemoryExtractor(brain, store);

      extractor.extractAndStore("user-1", "I also play piano", "Noted, sir.");
      await flush();

      // The existing, unrelated memory is untouched...
      expect(store.getByKey("user.location")?.value).toBe("lives in Haifa");
      // ...and the new, unrelated fact was saved as its own ordinary record.
      expect(store.getByKey("user.hobby.piano")?.value).toBe("plays classical piano");
      // No flagged conflict of any kind was raised for an unrelated fact.
      expect(store.getConflicts()).toHaveLength(0);

      // The extraction call was shown the existing-memories digest (the
      // mechanism this feature relies on), proving it had the visibility to
      // make this call, not that it was never given the chance.
      expect(brain.requests[0]?.context).toContain("user.location: lives in Haifa");
      store.close();
    });

    test("clear update: a confident semantic update reuses the existing key and the old value is visible in memory_history", async () => {
      const store = new MemoryStore(":memory:");
      // Saved as BACKGROUND_INFERRED (e.g. from an earlier extraction pass,
      // not an explicit SAVE_MEMORY) so the Memory Poisoning Defense's
      // trust-rank check (equal-trust always overwrites) doesn't get in the
      // way of observing THIS feature in isolation — see the test below for
      // how a higher-trust (USER_STATED) existing value is correctly left
      // to that separate, pre-existing defense instead.
      store.save({ key: "user.location", value: "lives in Haifa", category: "fact", source: "BACKGROUND_INFERRED" });
      // The extraction model recognizes "moved to Tel Aviv" as the same
      // underlying fact (where David lives) and reuses the EXISTING key
      // directly, exactly as buildExistingMemoriesSection instructs it to.
      const brain = new ScriptedBrain([
        jsonResponse('[{"key":"user.location","value":"just moved to Tel Aviv","category":"fact","confidence":0.9}]'),
      ]);
      const extractor = new MemoryExtractor(brain, store);

      extractor.extractAndStore("user-1", "I just moved to Tel Aviv", "Congratulations on the move, sir.");
      await flush();

      // The update won...
      expect(store.getByKey("user.location")?.value).toBe("just moved to Tel Aviv");
      // ...no second, duplicate "location" record was created...
      expect(store.getActive().filter((r) => r.value.includes("Haifa") || r.value.includes("Tel Aviv"))).toHaveLength(1);
      // ...and the old value is still visible, not silently lost, via the
      // same memory_history audit trail every other update already uses.
      const history = store.getHistory("user.location");
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({
        oldValue: "lives in Haifa",
        newValue: "just moved to Tel Aviv",
        flaggedConflict: false,
      });
      store.close();
    });

    test("a confident semantic update of a higher-trust (USER_STATED) existing value still goes through the Memory Poisoning Defense, not a silent overwrite", async () => {
      const store = new MemoryStore(":memory:");
      store.save({ key: "user.location", value: "lives in Haifa", category: "fact", source: "USER_STATED" });
      const brain = new ScriptedBrain([
        jsonResponse('[{"key":"user.location","value":"just moved to Tel Aviv","category":"fact","confidence":0.9}]'),
      ]);
      const extractor = new MemoryExtractor(brain, store);

      extractor.extractAndStore("user-1", "I just moved to Tel Aviv", "Congratulations on the move, sir.");
      await flush();

      // Reusing the key doesn't bypass the Memory Poisoning Defense: a
      // BACKGROUND_INFERRED write is still never allowed to overwrite a
      // higher-trust USER_STATED value for the same key — the existing
      // trust-rank rejection fires exactly as it already does for any other
      // same-key write, and the attempt is still flagged in memory_history.
      expect(store.getByKey("user.location")?.value).toBe("lives in Haifa");
      expect(store.getConflicts("user.location")).toHaveLength(1);
      store.close();
    });

    test("ambiguous case: a suspected-but-unconfident update is flagged, not silently guessed either way", async () => {
      const store = new MemoryStore(":memory:");
      store.save({ key: "user.job", value: "Software Engineer at Acme", category: "fact", source: "USER_STATED" });
      // The model isn't confident "consulting for Acme on the side" replaces
      // the existing job fact (it might just be additional, unrelated
      // information) — so it gives the new fact its own key and flags it.
      const brain = new ScriptedBrain([
        jsonResponse(
          '[{"key":"user.side_work","value":"doing some consulting for Acme on the side","category":"fact","confidence":0.6,"ambiguousUpdateOf":"user.job"}]'
        ),
      ]);
      const extractor = new MemoryExtractor(brain, store);

      extractor.extractAndStore("user-1", "I'm also doing some consulting for Acme on the side", "Noted, sir.");
      await flush();

      // The original fact is left completely untouched — no silent overwrite.
      expect(store.getByKey("user.job")?.value).toBe("Software Engineer at Acme");
      // The new fact was still saved, under its own key — nothing was dropped.
      expect(store.getByKey("user.side_work")?.value).toBe("doing some consulting for Acme on the side");
      // A visible, flagged audit trail exists against the candidate key,
      // through the exact same getConflicts() surface as a rejected
      // trust-rank write — not a silent guess in either direction.
      const conflicts = store.getConflicts("user.job");
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]?.flaggedConflict).toBe(true);
      expect(conflicts[0]?.oldValue).toBe("Software Engineer at Acme");
      expect(conflicts[0]?.newValue).toContain("doing some consulting for Acme on the side");
      expect(conflicts[0]?.newValue).toContain("user.side_work");
      store.close();
    });

    test("ambiguousUpdateOf pointing at a nonexistent key is simply ignored, not thrown", async () => {
      const store = new MemoryStore(":memory:");
      const brain = new ScriptedBrain([
        jsonResponse('[{"key":"user.new_fact","value":"something new","category":"fact","ambiguousUpdateOf":"no.such.key"}]'),
      ]);
      const extractor = new MemoryExtractor(brain, store);

      expect(() => extractor.extractAndStore("user-1", "something new", "Noted, sir.")).not.toThrow();
      await flush();

      expect(store.getByKey("user.new_fact")?.value).toBe("something new");
      expect(store.getConflicts()).toHaveLength(0);
      store.close();
    });

    test("the existing-memories digest is omitted entirely when the store has nothing active yet", async () => {
      const store = new MemoryStore(":memory:");
      const brain = new ScriptedBrain([jsonResponse("[]")]);
      const extractor = new MemoryExtractor(brain, store);

      extractor.extractAndStore("user-1", "hello", "hi there");
      await flush();

      expect(brain.requests[0]?.context).not.toContain("Existing memories already on record");
      store.close();
    });
  });

  test("respects ZERO_COST_MODE / budget enforcement by going through the same Brain the caller supplies", async () => {
    const store = new MemoryStore(":memory:");
    class RefusingBrain implements Brain {
      async chat(): Promise<BrainResponse> {
        throw new Error(
          'ZERO_COST_MODE is enabled and no free-tier provider is configured at all — refusing to call the paid "anthropic" provider.'
        );
      }
    }
    const extractor = new MemoryExtractor(new RefusingBrain(), store);

    expect(() => extractor.extractAndStore("user-1", "hello", "hi")).not.toThrow();
    await flush();

    expect(store.getActive()).toEqual([]);
    store.close();
  });
});
