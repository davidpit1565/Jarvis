import { describe, test, expect } from "bun:test";
import { MemoryExtractor } from "@/memory/MemoryExtractor";
import { MemoryStore } from "@/memory/MemoryStore";
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
