import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { WakeUpCallStore } from "@/wakeup/WakeUpCallStore";
import { createCreateWakeUpCallTool } from "@/tools/wakeup/CreateWakeUpCallTool";
import { PermissionLevel } from "@/types/permissions";

const context = { userId: "user-1", requestId: "req-1" };

describe("CREATE_WAKEUP_CALL tool", () => {
  let store: WakeUpCallStore;

  beforeEach(() => {
    store = new WakeUpCallStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  test("is SAFE_ACTION", () => {
    const tool = createCreateWakeUpCallTool(store);
    expect(tool.requiredPermission).toBe(PermissionLevel.SAFE_ACTION);
  });

  test("creates a wake-up call", async () => {
    const tool = createCreateWakeUpCallTool(store);
    const result = await tool.execute({ timeOfDay: "07:00", label: "wake up" }, context);

    expect(result.success).toBe(true);
    expect(store.list()).toHaveLength(1);
  });

  test("rejects an invalid timeOfDay", async () => {
    const tool = createCreateWakeUpCallTool(store);
    const result = await tool.execute({ timeOfDay: "not-a-time" }, context);

    expect(result.success).toBe(false);
    expect(store.list()).toHaveLength(0);
  });
});
