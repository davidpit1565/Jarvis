import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { ConversationHistoryStore } from "@/history/ConversationHistoryStore";
import { createSearchConversationHistoryTool } from "@/tools/history/SearchConversationHistoryTool";
import { PermissionLevel } from "@/types/permissions";

const context = { userId: "user-1", requestId: "req-1" };

describe("SEARCH_CONVERSATION_HISTORY tool", () => {
  let store: ConversationHistoryStore;

  beforeEach(() => {
    store = new ConversationHistoryStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  test("is read-only", () => {
    const tool = createSearchConversationHistoryTool(store);
    expect(tool.target).toBe("local");
    expect(tool.requiredPermission).toBe(PermissionLevel.READ);
  });

  test("finds a past message", async () => {
    store.record("user", "remind me about the Tel Aviv trip");
    const tool = createSearchConversationHistoryTool(store);

    const result = await tool.execute({ query: "Tel Aviv" }, context);

    expect(result.success).toBe(true);
    expect((result.data as { results: unknown[] }).results).toHaveLength(1);
  });

  test("rejects an empty query", async () => {
    const tool = createSearchConversationHistoryTool(store);
    const result = await tool.execute({ query: "" }, context);
    expect(result.success).toBe(false);
  });

  test("honors a custom limit", async () => {
    for (let i = 0; i < 5; i++) store.record("user", `apple ${i}`);
    const tool = createSearchConversationHistoryTool(store);

    const result = await tool.execute({ query: "apple", limit: 2 }, context);

    expect((result.data as { results: unknown[] }).results).toHaveLength(2);
  });
});
