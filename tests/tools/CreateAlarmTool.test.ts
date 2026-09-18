import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { AlarmStore } from "@/alarms/AlarmStore";
import { createCreateAlarmTool } from "@/tools/alarms/CreateAlarmTool";
import { PermissionLevel } from "@/types/permissions";

const context = { userId: "user-1", requestId: "req-1" };

describe("CREATE_ALARM tool", () => {
  let store: AlarmStore;

  beforeEach(() => {
    store = new AlarmStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  test("is SAFE_ACTION", () => {
    const tool = createCreateAlarmTool(store);
    expect(tool.requiredPermission).toBe(PermissionLevel.SAFE_ACTION);
  });

  test("creates an alarm", async () => {
    const tool = createCreateAlarmTool(store);
    const result = await tool.execute({ timeOfDay: "07:00", label: "gym" }, context);

    expect(result.success).toBe(true);
    expect(store.list()).toHaveLength(1);
  });

  test("rejects an invalid timeOfDay", async () => {
    const tool = createCreateAlarmTool(store);
    const result = await tool.execute({ timeOfDay: "not-a-time" }, context);

    expect(result.success).toBe(false);
    expect(store.list()).toHaveLength(0);
  });
});
