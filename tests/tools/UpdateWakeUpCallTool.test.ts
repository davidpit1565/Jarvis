import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { WakeUpCallStore } from "@/wakeup/WakeUpCallStore";
import { createUpdateWakeUpCallTool } from "@/tools/wakeup/UpdateWakeUpCallTool";
import { PermissionLevel } from "@/types/permissions";

const context = { userId: "user-1", requestId: "req-1" };

describe("UPDATE_WAKEUP_CALL tool", () => {
  let store: WakeUpCallStore;

  beforeEach(() => {
    store = new WakeUpCallStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  test("is SAFE_ACTION", () => {
    const tool = createUpdateWakeUpCallTool(store);
    expect(tool.requiredPermission).toBe(PermissionLevel.SAFE_ACTION);
  });

  test("updates the time of day", async () => {
    const record = store.create({ timeOfDay: "07:00" });
    const tool = createUpdateWakeUpCallTool(store);

    const result = await tool.execute({ id: record.id, timeOfDay: "08:00" }, context);

    expect(result.success).toBe(true);
    expect(store.list()[0]?.timeOfDay).toBe("08:00");
  });

  test("rejects an invalid timeOfDay", async () => {
    const record = store.create({ timeOfDay: "07:00" });
    const tool = createUpdateWakeUpCallTool(store);

    const result = await tool.execute({ id: record.id, timeOfDay: "bad" }, context);
    expect(result.success).toBe(false);
  });

  test("fails for an unknown id", async () => {
    const tool = createUpdateWakeUpCallTool(store);
    const result = await tool.execute({ id: "does-not-exist", timeOfDay: "08:00" }, context);
    expect(result.success).toBe(false);
  });
});
