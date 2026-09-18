import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { AlarmStore } from "@/alarms/AlarmStore";
import { createDeleteAlarmTool } from "@/tools/alarms/DeleteAlarmTool";
import { PermissionLevel } from "@/types/permissions";

const context = { userId: "user-1", requestId: "req-1" };

describe("DELETE_ALARM tool", () => {
  let store: AlarmStore;

  beforeEach(() => {
    store = new AlarmStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  test("is SAFE_ACTION", () => {
    const tool = createDeleteAlarmTool(store);
    expect(tool.requiredPermission).toBe(PermissionLevel.SAFE_ACTION);
  });

  test("deletes an existing alarm", async () => {
    const record = store.create({ timeOfDay: "07:00" });
    const tool = createDeleteAlarmTool(store);

    const result = await tool.execute({ id: record.id }, context);
    expect(result.success).toBe(true);
    expect(store.list()).toHaveLength(0);
  });

  test("fails for an unknown id", async () => {
    const tool = createDeleteAlarmTool(store);
    const result = await tool.execute({ id: "does-not-exist" }, context);
    expect(result.success).toBe(false);
  });
});
