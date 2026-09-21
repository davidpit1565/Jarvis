import { describe, test, expect } from "bun:test";
import { scopeToolsForMessage } from "@/core/intent/ToolScoping";
import { PermissionLevel } from "@/types/permissions";
import type { LocalTool } from "@/types/tools";

function tool(id: string): LocalTool {
  return {
    id,
    name: id.toLowerCase(),
    description: `test tool ${id}`,
    inputSchema: { type: "object", properties: {} },
    requiredPermission: PermissionLevel.READ,
    target: "local",
    execute: async () => ({ success: true }),
  };
}

const ALL_TOOLS: LocalTool[] = [
  tool("GET_WEATHER"),
  tool("GET_WEATHER_FORECAST"),
  tool("LIST_CALENDAR_EVENTS"),
  tool("SEND_EMAIL"),
  tool("GET_EMAIL"),
  tool("NOTIFY_USER"),
  tool("SEND_SMS"),
  tool("WRITE_FILE"),
  tool("READ_TEXT_FILE"),
  tool("SAVE_MEMORY"),
  tool("SEARCH_MEMORY"),
  tool("CREATE_REMINDER"),
  tool("LIST_REMINDERS"),
  tool("UNDO_LAST_ACTION"),
  tool("SOME_BRAND_NEW_TOOL_NOBODY_CLASSIFIED_YET"),
];

describe("scopeToolsForMessage", () => {
  test("a weather-only message scopes out Gmail/Telegram/SMS/file-write tools", () => {
    const scoped = scopeToolsForMessage("what's the weather like today", ALL_TOOLS);
    const scopedIds = scoped.map((t) => t.id);

    expect(scopedIds).toContain("GET_WEATHER");
    expect(scopedIds).toContain("GET_WEATHER_FORECAST");
    expect(scopedIds).not.toContain("SEND_EMAIL");
    expect(scopedIds).not.toContain("GET_EMAIL");
    expect(scopedIds).not.toContain("NOTIFY_USER");
    expect(scopedIds).not.toContain("SEND_SMS");
    expect(scopedIds).not.toContain("WRITE_FILE");
    expect(scopedIds).not.toContain("READ_TEXT_FILE");
    expect(scopedIds).not.toContain("LIST_CALENDAR_EVENTS");
  });

  test("the always-on core set (memory, reminders, undo) is present even on a scoped weather message", () => {
    const scoped = scopeToolsForMessage("what's the weather", ALL_TOOLS).map((t) => t.id);
    expect(scoped).toContain("SAVE_MEMORY");
    expect(scoped).toContain("SEARCH_MEMORY");
    expect(scoped).toContain("CREATE_REMINDER");
    expect(scoped).toContain("LIST_REMINDERS");
    expect(scoped).toContain("UNDO_LAST_ACTION");
  });

  test("a tool this module has no topic mapping for is never hidden, even when scoped", () => {
    const scoped = scopeToolsForMessage("what's the weather", ALL_TOOLS).map((t) => t.id);
    expect(scoped).toContain("SOME_BRAND_NEW_TOOL_NOBODY_CLASSIFIED_YET");
  });

  test("an ambiguous message (no clear topic) falls back to the full tool set", () => {
    const scoped = scopeToolsForMessage("hi there", ALL_TOOLS);
    expect(scoped).toHaveLength(ALL_TOOLS.length);
    expect(scoped.map((t) => t.id).sort()).toEqual(ALL_TOOLS.map((t) => t.id).sort());
  });

  test("a genuinely multi-topic message falls back to the full tool set rather than guessing", () => {
    const scoped = scopeToolsForMessage("what's the weather and did I get any new email?", ALL_TOOLS);
    expect(scoped).toHaveLength(ALL_TOOLS.length);
  });

  test("recentContext is folded into the topic classification alongside the current message", () => {
    // The message alone ("and tomorrow?") carries no topic signal; the
    // prior turn's text supplies it.
    const scoped = scopeToolsForMessage("and tomorrow?", ALL_TOOLS, "what's the weather like");
    const scopedIds = scoped.map((t) => t.id);
    expect(scopedIds).toContain("GET_WEATHER");
    expect(scopedIds).not.toContain("SEND_EMAIL");
  });

  test("never adds a tool that wasn't in the input list", () => {
    const scoped = scopeToolsForMessage("what's the weather", [tool("GET_WEATHER")]);
    expect(scoped).toHaveLength(1);
    expect(scoped[0]!.id).toBe("GET_WEATHER");
  });
});
