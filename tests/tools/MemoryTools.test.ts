import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { MemoryStore } from "@/memory/MemoryStore";
import { createSaveMemoryTool } from "@/tools/memory/SaveMemoryTool";
import { createSearchMemoryTool } from "@/tools/memory/SearchMemoryTool";
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
});
