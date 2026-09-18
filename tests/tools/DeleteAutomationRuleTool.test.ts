import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { AutomationRuleStore } from "@/automation/AutomationRuleStore";
import { createDeleteAutomationRuleTool } from "@/tools/automation/DeleteAutomationRuleTool";
import { PermissionLevel } from "@/types/permissions";

const context = { userId: "user-1", requestId: "req-1" };

describe("DELETE_AUTOMATION_RULE tool", () => {
  let store: AutomationRuleStore;

  beforeEach(() => {
    store = new AutomationRuleStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  test("is SAFE_ACTION", () => {
    const tool = createDeleteAutomationRuleTool(store);
    expect(tool.requiredPermission).toBe(PermissionLevel.SAFE_ACTION);
  });

  test("deletes an existing automation rule", async () => {
    const record = store.create({ timeOfDay: "08:00", instruction: "check the weather" });
    const tool = createDeleteAutomationRuleTool(store);

    const result = await tool.execute({ id: record.id }, context);
    expect(result.success).toBe(true);
    expect(store.list()).toHaveLength(0);
  });

  test("fails for an unknown id", async () => {
    const tool = createDeleteAutomationRuleTool(store);
    const result = await tool.execute({ id: "does-not-exist" }, context);
    expect(result.success).toBe(false);
  });
});
