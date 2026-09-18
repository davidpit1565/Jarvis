import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { ReminderStore } from "@/reminders/ReminderStore";
import { createCreateReminderTool } from "@/tools/reminders/CreateReminderTool";
import { createListRemindersTool } from "@/tools/reminders/ListRemindersTool";
import { createCompleteReminderTool } from "@/tools/reminders/CompleteReminderTool";
import { PermissionLevel } from "@/types/permissions";

const context = { userId: "user-1", requestId: "req-1" };

describe("CREATE_REMINDER tool", () => {
  let store: ReminderStore;

  beforeEach(() => {
    store = new ReminderStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  test("is a local tool requiring SAFE_ACTION", () => {
    const tool = createCreateReminderTool(store);
    expect(tool.target).toBe("local");
    expect(tool.requiredPermission).toBe(PermissionLevel.SAFE_ACTION);
    expect(tool.id).toBe("CREATE_REMINDER");
  });

  test("creates an undated reminder", async () => {
    const tool = createCreateReminderTool(store);
    const result = await tool.execute({ text: "Pick up dry cleaning" }, context);

    expect(result.success).toBe(true);
    expect(store.list()).toHaveLength(1);
  });

  test("creates a dated reminder", async () => {
    const tool = createCreateReminderTool(store);
    const result = await tool.execute({ text: "Call mom", dueAt: "2026-09-19T18:00:00.000Z" }, context);

    expect(result.success).toBe(true);
    expect(store.list()[0]?.dueAt).toBe("2026-09-19T18:00:00.000Z");
  });

  test("rejects an empty text", async () => {
    const tool = createCreateReminderTool(store);
    const result = await tool.execute({ text: "" }, context);
    expect(result.success).toBe(false);
  });

  test("rejects an invalid dueAt", async () => {
    const tool = createCreateReminderTool(store);
    const result = await tool.execute({ text: "Task", dueAt: "not-a-date" }, context);
    expect(result.success).toBe(false);
  });
});

describe("LIST_REMINDERS tool", () => {
  let store: ReminderStore;

  beforeEach(() => {
    store = new ReminderStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  test("is read-only", () => {
    const tool = createListRemindersTool(store);
    expect(tool.target).toBe("local");
    expect(tool.requiredPermission).toBe(PermissionLevel.READ);
  });

  test("excludes completed reminders by default", async () => {
    const a = store.create({ text: "Task A" });
    store.create({ text: "Task B" });
    store.complete(a.id);

    const tool = createListRemindersTool(store);
    const result = await tool.execute({}, context);

    expect(result.success).toBe(true);
    expect((result.data as { reminders: unknown[] }).reminders).toHaveLength(1);
  });

  test("includeCompleted=true returns everything", async () => {
    const a = store.create({ text: "Task A" });
    store.create({ text: "Task B" });
    store.complete(a.id);

    const tool = createListRemindersTool(store);
    const result = await tool.execute({ includeCompleted: true }, context);

    expect((result.data as { reminders: unknown[] }).reminders).toHaveLength(2);
  });
});

describe("COMPLETE_REMINDER tool", () => {
  let store: ReminderStore;

  beforeEach(() => {
    store = new ReminderStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  test("is a local tool requiring SAFE_ACTION", () => {
    const tool = createCompleteReminderTool(store);
    expect(tool.target).toBe("local");
    expect(tool.requiredPermission).toBe(PermissionLevel.SAFE_ACTION);
  });

  test("marks a reminder complete", async () => {
    const record = store.create({ text: "Task" });
    const tool = createCompleteReminderTool(store);

    const result = await tool.execute({ id: record.id }, context);

    expect(result.success).toBe(true);
    expect(store.get(record.id)?.completed).toBe(true);
  });

  test("fails for an unknown id", async () => {
    const tool = createCompleteReminderTool(store);
    const result = await tool.execute({ id: "missing" }, context);
    expect(result.success).toBe(false);
  });

  test("rejects an empty id", async () => {
    const tool = createCompleteReminderTool(store);
    const result = await tool.execute({ id: "" }, context);
    expect(result.success).toBe(false);
  });
});
