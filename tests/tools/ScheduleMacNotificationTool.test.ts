import { describe, test, expect } from "bun:test";
import { scheduleMacNotificationTool } from "@/tools/system/ScheduleMacNotificationTool";
import { ToolRegistry } from "@/tools/registry/ToolRegistry";
import { PermissionLevel } from "@/types/permissions";

describe("SCHEDULE_MAC_NOTIFICATION tool definition", () => {
  test("is a device-targeted tool with no local execute()", () => {
    expect(scheduleMacNotificationTool.target).toBe("device");
    expect("execute" in scheduleMacNotificationTool).toBe(false);
  });

  test("is SAFE_ACTION — fully specified effect, not open-ended like CLICK_ELEMENT", () => {
    expect(scheduleMacNotificationTool.requiredPermission).toBe(PermissionLevel.SAFE_ACTION);
  });

  test("requires message; title/delaySeconds/deviceId are optional", () => {
    expect(scheduleMacNotificationTool.inputSchema.required).toEqual(["message"]);
    expect(scheduleMacNotificationTool.inputSchema.properties).toHaveProperty("title");
    expect(scheduleMacNotificationTool.inputSchema.properties).toHaveProperty("delaySeconds");
    expect(scheduleMacNotificationTool.inputSchema.properties).toHaveProperty("deviceId");
  });

  describe("validateInput (Core-side defense in depth)", () => {
    test("accepts a plain message with no delaySeconds", () => {
      expect(scheduleMacNotificationTool.validateInput?.({ message: "Time to stand up" }).valid).toBe(true);
    });

    test("accepts a message with a delaySeconds within range", () => {
      expect(scheduleMacNotificationTool.validateInput?.({ message: "hi", delaySeconds: 600 }).valid).toBe(true);
    });

    test("rejects a missing or empty message", () => {
      expect(scheduleMacNotificationTool.validateInput?.({}).valid).toBe(false);
      expect(scheduleMacNotificationTool.validateInput?.({ message: "" }).valid).toBe(false);
      expect(scheduleMacNotificationTool.validateInput?.({ message: "   " }).valid).toBe(false);
      expect(scheduleMacNotificationTool.validateInput?.({ message: 5 }).valid).toBe(false);
    });

    test("rejects a negative delaySeconds", () => {
      expect(scheduleMacNotificationTool.validateInput?.({ message: "hi", delaySeconds: -1 }).valid).toBe(false);
    });

    test("rejects a delaySeconds over the documented 24-hour cap", () => {
      expect(scheduleMacNotificationTool.validateInput?.({ message: "hi", delaySeconds: 86401 }).valid).toBe(false);
    });

    test("accepts delaySeconds exactly at the 24-hour cap", () => {
      expect(scheduleMacNotificationTool.validateInput?.({ message: "hi", delaySeconds: 86400 }).valid).toBe(true);
    });

    test("rejects a non-numeric delaySeconds", () => {
      expect(scheduleMacNotificationTool.validateInput?.({ message: "hi", delaySeconds: "600" }).valid).toBe(false);
    });
  });

  test("registers cleanly and produces a Claude-compatible tool definition", () => {
    const registry = new ToolRegistry();
    registry.registerTool(scheduleMacNotificationTool);

    const definitions = registry.toToolDefinitions();
    expect(definitions).toContainEqual({
      name: "schedule_mac_notification",
      description: scheduleMacNotificationTool.description,
      input_schema: scheduleMacNotificationTool.inputSchema,
    });
  });
});
