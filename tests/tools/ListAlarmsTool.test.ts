import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { AlarmStore } from "@/alarms/AlarmStore";
import { createListAlarmsTool } from "@/tools/alarms/ListAlarmsTool";
import { PermissionLevel } from "@/types/permissions";

const context = { userId: "user-1", requestId: "req-1" };

describe("LIST_ALARMS tool", () => {
  let store: AlarmStore;

  beforeEach(() => {
    store = new AlarmStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  test("is READ", () => {
    const tool = createListAlarmsTool(store);
    expect(tool.requiredPermission).toBe(PermissionLevel.READ);
  });

  test("lists scheduled alarms", async () => {
    store.create({ timeOfDay: "07:00" });
    const tool = createListAlarmsTool(store);

    const result = await tool.execute({}, context);
    expect(result.success).toBe(true);
    expect((result.data as { alarms: unknown[] }).alarms).toHaveLength(1);
  });
});
