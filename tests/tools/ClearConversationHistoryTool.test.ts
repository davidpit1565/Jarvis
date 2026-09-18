import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { ConversationHistoryStore } from "@/history/ConversationHistoryStore";
import { createClearConversationHistoryTool } from "@/tools/history/ClearConversationHistoryTool";
import { PermissionLevel } from "@/types/permissions";

const context = { userId: "user-1", requestId: "req-1" };

describe("CLEAR_CONVERSATION_HISTORY tool", () => {
  let store: ConversationHistoryStore;

  beforeEach(() => {
    store = new ConversationHistoryStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  test("is DANGEROUS, not a lesser permission level", () => {
    const tool = createClearConversationHistoryTool(store);
    expect(tool.target).toBe("local");
    expect(tool.requiredPermission).toBe(PermissionLevel.DANGEROUS);
  });

  test("erases the entire transcript and reports how many turns were removed", async () => {
    store.record("user", "hello");
    store.record("assistant", "hi there");
    const tool = createClearConversationHistoryTool(store);

    const result = await tool.execute({}, context);

    expect(result.success).toBe(true);
    expect((result.data as { deletedCount: number }).deletedCount).toBe(2);
    expect(store.count()).toBe(0);
  });

  test("succeeds with zero deletions on an already-empty store", async () => {
    const tool = createClearConversationHistoryTool(store);
    const result = await tool.execute({}, context);

    expect(result.success).toBe(true);
    expect((result.data as { deletedCount: number }).deletedCount).toBe(0);
  });
});
