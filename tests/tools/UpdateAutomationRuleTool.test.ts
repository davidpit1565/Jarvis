import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { AutomationRuleStore } from "@/automation/AutomationRuleStore";
import { createUpdateAutomationRuleTool } from "@/tools/automation/UpdateAutomationRuleTool";
import { PermissionLevel } from "@/types/permissions";

const context = { userId: "user-1", requestId: "req-1" };

describe("UPDATE_AUTOMATION_RULE tool", () => {
  let store: AutomationRuleStore;

  beforeEach(() => {
    store = new AutomationRuleStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  test("is SAFE_ACTION", () => {
    const tool = createUpdateAutomationRuleTool(store);
    expect(tool.requiredPermission).toBe(PermissionLevel.SAFE_ACTION);
  });

  test("updates the time of day", async () => {
    const record = store.create({ timeOfDay: "08:00", instruction: "check the weather" });
    const tool = createUpdateAutomationRuleTool(store);

    const result = await tool.execute({ id: record.id, timeOfDay: "09:00" }, context);

    expect(result.success).toBe(true);
    expect(store.list()[0]?.timeOfDay).toBe("09:00");
  });

  test("updates the instruction", async () => {
    const record = store.create({ timeOfDay: "08:00", instruction: "check the weather" });
    const tool = createUpdateAutomationRuleTool(store);

    const result = await tool.execute({ id: record.id, instruction: "check the news" }, context);

    expect(result.success).toBe(true);
    expect(store.list()[0]?.instruction).toBe("check the news");
  });

  test("rejects an invalid timeOfDay", async () => {
    const record = store.create({ timeOfDay: "08:00", instruction: "check the weather" });
    const tool = createUpdateAutomationRuleTool(store);

    const result = await tool.execute({ id: record.id, timeOfDay: "bad" }, context);
    expect(result.success).toBe(false);
  });

  test("rejects an empty instruction", async () => {
    const record = store.create({ timeOfDay: "08:00", instruction: "check the weather" });
    const tool = createUpdateAutomationRuleTool(store);

    const result = await tool.execute({ id: record.id, instruction: "  " }, context);
    expect(result.success).toBe(false);
  });

  test("fails for an unknown id", async () => {
    const tool = createUpdateAutomationRuleTool(store);
    const result = await tool.execute({ id: "does-not-exist", timeOfDay: "09:00" }, context);
    expect(result.success).toBe(false);
  });

  test("can toggle enabled to pause/resume without deleting", async () => {
    const record = store.create({ timeOfDay: "08:00", instruction: "check the weather" });
    const tool = createUpdateAutomationRuleTool(store);

    const paused = await tool.execute({ id: record.id, enabled: false }, context);
    expect(paused.success).toBe(true);
    expect(store.list()[0]?.enabled).toBe(false);

    const resumed = await tool.execute({ id: record.id, enabled: true }, context);
    expect(resumed.success).toBe(true);
    expect(store.list()[0]?.enabled).toBe(true);
  });

  test("rejects a non-boolean enabled", async () => {
    const record = store.create({ timeOfDay: "08:00", instruction: "check the weather" });
    const tool = createUpdateAutomationRuleTool(store);

    const result = await tool.execute({ id: record.id, enabled: "no" as unknown as boolean }, context);
    expect(result.success).toBe(false);
  });
});
