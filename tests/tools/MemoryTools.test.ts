import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { MemoryStore } from "@/memory/MemoryStore";
import { createSaveMemoryTool } from "@/tools/memory/SaveMemoryTool";
import { createSearchMemoryTool } from "@/tools/memory/SearchMemoryTool";
import { createDeleteMemoryTool } from "@/tools/memory/DeleteMemoryTool";
import { UndoStore } from "@/core/undo/UndoStore";
import { PermissionLevel } from "@/types/permissions";

const context = { userId: "user-1", requestId: "req-1" };

describe("SAVE_MEMORY tool", () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  test("is a local tool requiring SAFE_ACTION", () => {
    const tool = createSaveMemoryTool(store);
    expect(tool.target).toBe("local");
    expect(tool.requiredPermission).toBe(PermissionLevel.SAFE_ACTION);
    expect(tool.id).toBe("SAVE_MEMORY");
  });

  test("saves a fact and it becomes searchable", async () => {
    const saveTool = createSaveMemoryTool(store);
    const result = await saveTool.execute({ key: "user.name", value: "David" }, context);

    expect(result.success).toBe(true);

    const searchTool = createSearchMemoryTool(store);
    const searchResult = await searchTool.execute({ query: "user.name" }, context);

    expect(searchResult.success).toBe(true);
    expect(searchResult.data).toEqual([{ key: "user.name", value: "David", savedAt: expect.any(String) }]);
  });

  test("rejects an empty key", async () => {
    const tool = createSaveMemoryTool(store);
    const result = await tool.execute({ key: "", value: "David" }, context);
    expect(result.success).toBe(false);
  });

  test("rejects an empty value", async () => {
    const tool = createSaveMemoryTool(store);
    const result = await tool.execute({ key: "user.name", value: "" }, context);
    expect(result.success).toBe(false);
  });

  describe("embedding computation (opt-in, additive)", () => {
    test("with no embeddings client, no embedding is stored (identical to before this feature existed)", async () => {
      const tool = createSaveMemoryTool(store);
      await tool.execute({ key: "user.name", value: "David" }, context);

      expect(store.searchSemantic([1, 0])).toEqual([]);
    });

    test("with an embeddings client, the computed embedding is stored and later semantically searchable", async () => {
      const fakeClient = { embed: async (text: string) => (text.includes("Cohen") ? [1, 0] : [0, 1]) };
      const tool = createSaveMemoryTool(store, fakeClient);
      await tool.execute({ key: "appointments.dentist", value: "appointment with Dr. Cohen" }, context);

      const results = store.searchSemantic([1, 0]);
      expect(results).toHaveLength(1);
      expect(results[0]?.key).toBe("appointments.dentist");
    });

    test("an unreachable embeddings client never fails the save itself", async () => {
      const throwingClient = { embed: async () => { throw new Error("Ollama unreachable"); } };
      const tool = createSaveMemoryTool(store, throwingClient);
      const result = await tool.execute({ key: "user.name", value: "David" }, context);

      expect(result.success).toBe(true);
      expect(store.getByKey("user.name")?.value).toBe("David");
    });
  });
});

describe("SEARCH_MEMORY tool", () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  test("is read-only", () => {
    const tool = createSearchMemoryTool(store);
    expect(tool.target).toBe("local");
    expect(tool.requiredPermission).toBe(PermissionLevel.READ);
  });

  test("lists everything when no query is given", async () => {
    store.save({ key: "user.name", value: "David" });
    store.save({ key: "device.mac", value: "MacBook" });

    const tool = createSearchMemoryTool(store);
    const result = await tool.execute({}, context);

    expect(result.success).toBe(true);
    expect((result.data as unknown[]).length).toBe(2);
  });

  test("returns an empty list when nothing matches", async () => {
    const tool = createSearchMemoryTool(store);
    const result = await tool.execute({ query: "nonexistent" }, context);

    expect(result.success).toBe(true);
    expect(result.data).toEqual([]);
  });

  describe("semantic search (opt-in, additive)", () => {
    test("with no embeddings client, behavior is byte-for-byte identical to exact-match-only search", async () => {
      store.save({ key: "appointments.medical", value: "appointment with Dr. Cohen" });
      const withoutClient = createSearchMemoryTool(store);

      const result = await withoutClient.execute({ query: "dentist" }, context);
      expect(result.success).toBe(true);
      expect(result.data).toEqual([]); // no word "dentist" in either the key or value fragment

      // Sanity check: an embeddings-client tool with the client always
      // throwing behaves identically to no client at all, further proving
      // the fallback path is exact-match-only, not "empty".
      const throwingClient = { embed: async () => { throw new Error("unreachable"); } };
      const withThrowingClient = createSearchMemoryTool(store, throwingClient);
      const resultWithThrowingClient = await withThrowingClient.execute({ query: "dentist" }, context);
      expect(resultWithThrowingClient).toEqual(result);
    });

    test("finds a semantically similar memory that shares no words with the query, when an embeddings client is given", async () => {
      // Simulate a real embeddings client with hand-picked vectors: the
      // "dentist" query embedding is close to the stored memory's saved
      // embedding, even though the text shares no words.
      const fakeClient = {
        embed: async (text: string) => (text === "dentist" ? [1, 0, 0] : [0, 0, 1]),
      };
      store.save({ key: "appointments.medical", value: "appointment with Dr. Cohen", embedding: [1, 0.1, 0] });

      const tool = createSearchMemoryTool(store, fakeClient);
      const result = await tool.execute({ query: "dentist" }, context);

      expect(result.success).toBe(true);
      expect(result.data).toEqual([{ key: "appointments.medical", value: "appointment with Dr. Cohen", savedAt: expect.any(String) }]);
    });

    test("exact matches come first, semantic matches are appended without duplicates", async () => {
      store.save({ key: "user.dentist_note", value: "dentist is closed on Mondays", embedding: [1, 0] });
      store.save({ key: "appointments.medical", value: "appointment with Dr. Cohen", embedding: [0.9, 0.1] });

      const fakeClient = { embed: async () => [1, 0] };
      const tool = createSearchMemoryTool(store, fakeClient);
      const result = await tool.execute({ query: "dentist" }, context);

      const keys = (result.data as Array<{ key: string }>).map((r) => r.key);
      expect(keys).toEqual(["user.dentist_note", "appointments.medical"]); // exact match first, semantic-only second
    });

    test("an empty query never triggers the embeddings client (nothing meaningful to embed)", async () => {
      let embedCalls = 0;
      const fakeClient = { embed: async () => { embedCalls++; return [1, 0]; } };
      store.save({ key: "a", value: "a", embedding: [1, 0] });

      const tool = createSearchMemoryTool(store, fakeClient);
      await tool.execute({}, context);

      expect(embedCalls).toBe(0);
    });
  });
});

describe("DELETE_MEMORY tool", () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  test("is a local tool requiring SAFE_ACTION", () => {
    const tool = createDeleteMemoryTool(store);
    expect(tool.target).toBe("local");
    expect(tool.requiredPermission).toBe(PermissionLevel.SAFE_ACTION);
  });

  test("deletes a fact by key", async () => {
    store.save({ key: "user.oldJob", value: "Acme Corp" });
    const tool = createDeleteMemoryTool(store);

    const result = await tool.execute({ key: "user.oldJob" }, context);

    expect(result.success).toBe(true);
    expect(store.search("user.oldJob")).toEqual([]);
  });

  test("fails for an unknown key", async () => {
    const tool = createDeleteMemoryTool(store);
    const result = await tool.execute({ key: "missing" }, context);
    expect(result.success).toBe(false);
  });

  test("rejects an empty key", async () => {
    const tool = createDeleteMemoryTool(store);
    const result = await tool.execute({ key: "" }, context);
    expect(result.success).toBe(false);
  });

  test("records the deleted fact's key/value to the undo store, when given one", async () => {
    store.save({ key: "user.oldJob", value: "Acme Corp" });
    const undoStore = new UndoStore();
    const tool = createDeleteMemoryTool(store, undoStore);

    await tool.execute({ key: "user.oldJob" }, context);

    expect(undoStore.takeLast()).toEqual({ type: "memory_deleted", key: "user.oldJob", value: "Acme Corp" });
  });

  test("does not record anything in the undo store on failure", async () => {
    const undoStore = new UndoStore();
    const tool = createDeleteMemoryTool(store, undoStore);

    await tool.execute({ key: "missing" }, context);

    expect(undoStore.takeLast()).toBeUndefined();
  });
});
