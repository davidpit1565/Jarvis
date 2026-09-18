import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { WakeUpCallStore } from "@/wakeup/WakeUpCallStore";
import { createListWakeUpCallsTool } from "@/tools/wakeup/ListWakeUpCallsTool";
import { PermissionLevel } from "@/types/permissions";

const context = { userId: "user-1", requestId: "req-1" };

describe("LIST_WAKEUP_CALLS tool", () => {
  let store: WakeUpCallStore;

  beforeEach(() => {
    store = new WakeUpCallStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  test("is READ", () => {
    const tool = createListWakeUpCallsTool(store);
    expect(tool.requiredPermission).toBe(PermissionLevel.READ);
  });

  test("lists scheduled calls", async () => {
    store.create({ timeOfDay: "07:00" });
    const tool = createListWakeUpCallsTool(store);

    const result = await tool.execute({}, context);
    expect(result.success).toBe(true);
    expect((result.data as { calls: unknown[] }).calls).toHaveLength(1);
  });
});
