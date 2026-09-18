import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { AutomationRuleStore } from "@/automation/AutomationRuleStore";
import { createListAutomationRulesTool } from "@/tools/automation/ListAutomationRulesTool";
import { PermissionLevel } from "@/types/permissions";

const context = { userId: "user-1", requestId: "req-1" };

describe("LIST_AUTOMATION_RULES tool", () => {
  let store: AutomationRuleStore;

  beforeEach(() => {
    store = new AutomationRuleStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  test("is READ", () => {
    const tool = createListAutomationRulesTool(store);
    expect(tool.requiredPermission).toBe(PermissionLevel.READ);
  });

  test("lists scheduled rules", async () => {
    store.create({ timeOfDay: "08:00", instruction: "check the weather" });
    const tool = createListAutomationRulesTool(store);

    const result = await tool.execute({}, context);
    expect(result.success).toBe(true);
    expect((result.data as { rules: unknown[] }).rules).toHaveLength(1);
  });
});
