import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { WakeUpCallStore } from "@/wakeup/WakeUpCallStore";
import { createDeleteWakeUpCallTool } from "@/tools/wakeup/DeleteWakeUpCallTool";
import { PermissionLevel } from "@/types/permissions";

const context = { userId: "user-1", requestId: "req-1" };

describe("DELETE_WAKEUP_CALL tool", () => {
  let store: WakeUpCallStore;

  beforeEach(() => {
    store = new WakeUpCallStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  test("is SAFE_ACTION", () => {
    const tool = createDeleteWakeUpCallTool(store);
    expect(tool.requiredPermission).toBe(PermissionLevel.SAFE_ACTION);
  });

  test("deletes an existing wake-up call", async () => {
    const record = store.create({ timeOfDay: "07:00" });
    const tool = createDeleteWakeUpCallTool(store);

    const result = await tool.execute({ id: record.id }, context);
    expect(result.success).toBe(true);
    expect(store.list()).toHaveLength(0);
  });

  test("fails for an unknown id", async () => {
    const tool = createDeleteWakeUpCallTool(store);
    const result = await tool.execute({ id: "does-not-exist" }, context);
    expect(result.success).toBe(false);
  });
});
