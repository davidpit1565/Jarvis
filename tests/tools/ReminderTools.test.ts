import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { ReminderStore } from "@/reminders/ReminderStore";
import { createCreateReminderTool } from "@/tools/reminders/CreateReminderTool";
import { createListRemindersTool } from "@/tools/reminders/ListRemindersTool";
import { createCompleteReminderTool } from "@/tools/reminders/CompleteReminderTool";
import { createDeleteReminderTool } from "@/tools/reminders/DeleteReminderTool";
import { createUpdateReminderTool } from "@/tools/reminders/UpdateReminderTool";
import { UndoStore } from "@/core/undo/UndoStore";
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
    const result = await tool.execute({ text: "Call mom", dueAt: "2030-09-19T18:00:00.000Z" }, context);

    expect(result.success).toBe(true);
    expect(store.list()[0]?.dueAt).toBe("2030-09-19T18:00:00.000Z");
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

  test("rejects a dueAt already in the past — a likely date-math slip resolving a relative phrase", async () => {
    const tool = createCreateReminderTool(store);
    const result = await tool.execute({ text: "Task", dueAt: "2020-01-01T00:00:00.000Z" }, context);
    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toMatch(/must not be in the past/);
    expect(store.list()).toHaveLength(0);
  });

  test("creates a recurring reminder with a dueAt", async () => {
    const tool = createCreateReminderTool(store);
    const result = await tool.execute(
      { text: "Take medication", dueAt: "2030-09-19T18:00:00.000Z", recurrence: "daily" },
      context
    );

    expect(result.success).toBe(true);
    expect(store.list()[0]?.recurrence).toBe("daily");
  });

  test("rejects an invalid recurrence value", async () => {
    const tool = createCreateReminderTool(store);
    const result = await tool.execute(
      { text: "Task", dueAt: "2030-09-19T18:00:00.000Z", recurrence: "hourly" as never },
      context
    );
    expect(result.success).toBe(false);
  });

  test("rejects a recurrence without a dueAt", async () => {
    const tool = createCreateReminderTool(store);
    const result = await tool.execute({ text: "Task", recurrence: "daily" }, context);
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

describe("DELETE_REMINDER tool", () => {
  let store: ReminderStore;

  beforeEach(() => {
    store = new ReminderStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  test("is a local tool requiring SAFE_ACTION", () => {
    const tool = createDeleteReminderTool(store);
    expect(tool.target).toBe("local");
    expect(tool.requiredPermission).toBe(PermissionLevel.SAFE_ACTION);
  });

  test("deletes a reminder entirely", async () => {
    const record = store.create({ text: "Task" });
    const tool = createDeleteReminderTool(store);

    const result = await tool.execute({ id: record.id }, context);

    expect(result.success).toBe(true);
    expect(store.get(record.id)).toBeNull();
  });

  test("fails for an unknown id", async () => {
    const tool = createDeleteReminderTool(store);
    const result = await tool.execute({ id: "missing" }, context);
    expect(result.success).toBe(false);
  });

  test("records the deleted reminder's fields to the undo store, when given one", async () => {
    const record = store.create({ text: "Buy milk", dueAt: "2030-09-19T18:00:00.000Z", recurrence: "daily" });
    const undoStore = new UndoStore();
    const tool = createDeleteReminderTool(store, undoStore);

    await tool.execute({ id: record.id }, context);

    expect(undoStore.takeLast()).toEqual({
      type: "reminder_deleted",
      text: "Buy milk",
      dueAt: "2030-09-19T18:00:00.000Z",
      recurrence: "daily",
    });
  });

  test("does not record anything in the undo store on failure", async () => {
    const undoStore = new UndoStore();
    const tool = createDeleteReminderTool(store, undoStore);

    await tool.execute({ id: "missing" }, context);

    expect(undoStore.takeLast()).toBeUndefined();
  });
});

describe("UPDATE_REMINDER tool", () => {
  let store: ReminderStore;

  beforeEach(() => {
    store = new ReminderStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  test("is a local tool requiring SAFE_ACTION", () => {
    const tool = createUpdateReminderTool(store);
    expect(tool.target).toBe("local");
    expect(tool.requiredPermission).toBe(PermissionLevel.SAFE_ACTION);
  });

  test("updates text and dueAt", async () => {
    const record = store.create({ text: "Call mom", dueAt: "2030-09-19T18:00:00.000Z" });
    const tool = createUpdateReminderTool(store);

    const result = await tool.execute({ id: record.id, text: "Call dad", dueAt: "2030-09-19T19:00:00.000Z" }, context);

    expect(result.success).toBe(true);
    expect(store.get(record.id)?.text).toBe("Call dad");
  });

  test("clears dueAt when passed null", async () => {
    const record = store.create({ text: "Task", dueAt: "2030-09-19T18:00:00.000Z" });
    const tool = createUpdateReminderTool(store);

    const result = await tool.execute({ id: record.id, dueAt: null }, context);

    expect(result.success).toBe(true);
    expect(store.get(record.id)?.dueAt).toBeNull();
  });

  test("fails for an unknown id", async () => {
    const tool = createUpdateReminderTool(store);
    const result = await tool.execute({ id: "missing", text: "x" }, context);
    expect(result.success).toBe(false);
  });

  test("rejects an empty text", async () => {
    const record = store.create({ text: "Task" });
    const tool = createUpdateReminderTool(store);
    const result = await tool.execute({ id: record.id, text: "" }, context);
    expect(result.success).toBe(false);
  });

  test("rejects an invalid dueAt", async () => {
    const record = store.create({ text: "Task" });
    const tool = createUpdateReminderTool(store);
    const result = await tool.execute({ id: record.id, dueAt: "not-a-date" }, context);
    expect(result.success).toBe(false);
  });

  test("rejects a new dueAt already in the past", async () => {
    const record = store.create({ text: "Task" });
    const tool = createUpdateReminderTool(store);
    const result = await tool.execute({ id: record.id, dueAt: "2020-01-01T00:00:00.000Z" }, context);
    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toMatch(/must not be in the past/);
    expect(store.get(record.id)?.dueAt).toBeNull();
  });

  test("sets recurrence on an existing reminder", async () => {
    const record = store.create({ text: "Task", dueAt: "2030-09-19T18:00:00.000Z" });
    const tool = createUpdateReminderTool(store);

    const result = await tool.execute({ id: record.id, recurrence: "weekly" }, context);

    expect(result.success).toBe(true);
    expect(store.get(record.id)?.recurrence).toBe("weekly");
  });

  test("clears recurrence when passed null — stops it from repeating", async () => {
    const record = store.create({ text: "Task", dueAt: "2030-09-19T18:00:00.000Z", recurrence: "daily" });
    const tool = createUpdateReminderTool(store);

    const result = await tool.execute({ id: record.id, recurrence: null }, context);

    expect(result.success).toBe(true);
    expect(store.get(record.id)?.recurrence).toBeNull();
  });

  test("rejects an invalid recurrence value", async () => {
    const record = store.create({ text: "Task" });
    const tool = createUpdateReminderTool(store);
    const result = await tool.execute({ id: record.id, recurrence: "hourly" as never }, context);
    expect(result.success).toBe(false);
  });
});
