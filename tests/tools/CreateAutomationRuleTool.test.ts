import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { AutomationRuleStore } from "@/automation/AutomationRuleStore";
import { createCreateAutomationRuleTool } from "@/tools/automation/CreateAutomationRuleTool";
import { PermissionLevel } from "@/types/permissions";

const context = { userId: "user-1", requestId: "req-1" };

describe("CREATE_AUTOMATION_RULE tool", () => {
  let store: AutomationRuleStore;

  beforeEach(() => {
    store = new AutomationRuleStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  test("is SAFE_ACTION", () => {
    const tool = createCreateAutomationRuleTool(store);
    expect(tool.requiredPermission).toBe(PermissionLevel.SAFE_ACTION);
  });

  test("creates an automation rule", async () => {
    const tool = createCreateAutomationRuleTool(store);
    const result = await tool.execute({ timeOfDay: "08:00", instruction: "check the weather" }, context);

    expect(result.success).toBe(true);
    expect(store.list()).toHaveLength(1);
  });

  test("rejects an invalid timeOfDay", async () => {
    const tool = createCreateAutomationRuleTool(store);
    const result = await tool.execute({ timeOfDay: "not-a-time", instruction: "check the weather" }, context);

    expect(result.success).toBe(false);
    expect(store.list()).toHaveLength(0);
  });

  test("rejects an empty instruction", async () => {
    const tool = createCreateAutomationRuleTool(store);
    const result = await tool.execute({ timeOfDay: "08:00", instruction: "  " }, context);

    expect(result.success).toBe(false);
    expect(store.list()).toHaveLength(0);
  });
});
