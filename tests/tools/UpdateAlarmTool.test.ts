import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { AlarmStore } from "@/alarms/AlarmStore";
import { createUpdateAlarmTool } from "@/tools/alarms/UpdateAlarmTool";
import { PermissionLevel } from "@/types/permissions";

const context = { userId: "user-1", requestId: "req-1" };

describe("UPDATE_ALARM tool", () => {
  let store: AlarmStore;

  beforeEach(() => {
    store = new AlarmStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  test("is SAFE_ACTION", () => {
    const tool = createUpdateAlarmTool(store);
    expect(tool.requiredPermission).toBe(PermissionLevel.SAFE_ACTION);
  });

  test("updates the time of day", async () => {
    const record = store.create({ timeOfDay: "07:00" });
    const tool = createUpdateAlarmTool(store);

    const result = await tool.execute({ id: record.id, timeOfDay: "08:00" }, context);

    expect(result.success).toBe(true);
    expect(store.list()[0]?.timeOfDay).toBe("08:00");
  });

  test("rejects an invalid timeOfDay", async () => {
    const record = store.create({ timeOfDay: "07:00" });
    const tool = createUpdateAlarmTool(store);

    const result = await tool.execute({ id: record.id, timeOfDay: "bad" }, context);
    expect(result.success).toBe(false);
  });

  test("fails for an unknown id", async () => {
    const tool = createUpdateAlarmTool(store);
    const result = await tool.execute({ id: "does-not-exist", timeOfDay: "08:00" }, context);
    expect(result.success).toBe(false);
  });

  test("can toggle enabled to pause/resume without deleting", async () => {
    const record = store.create({ timeOfDay: "07:00" });
    const tool = createUpdateAlarmTool(store);

    const paused = await tool.execute({ id: record.id, enabled: false }, context);
    expect(paused.success).toBe(true);
    expect(store.list()[0]?.enabled).toBe(false);

    const resumed = await tool.execute({ id: record.id, enabled: true }, context);
    expect(resumed.success).toBe(true);
    expect(store.list()[0]?.enabled).toBe(true);
  });

  test("rejects a non-boolean enabled", async () => {
    const record = store.create({ timeOfDay: "07:00" });
    const tool = createUpdateAlarmTool(store);

    const result = await tool.execute({ id: record.id, enabled: "no" as unknown as boolean }, context);
    expect(result.success).toBe(false);
  });
});
