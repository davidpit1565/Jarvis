import { describe, test, expect } from "bun:test";
import { buildAnthropicTools, fromAnthropicResponse } from "@/core/brain/ClaudeBrain";
import type { ToolDefinition } from "@/types/tools";
import type Anthropic from "@anthropic-ai/sdk";

const ECHO_TOOL: ToolDefinition = {
  name: "echo_tool",
  description: "Echoes input",
  input_schema: { type: "object", properties: {} },
};

describe("buildAnthropicTools", () => {
  test("maps registered tools without adding web_search when disabled", () => {
    const tools = buildAnthropicTools([ECHO_TOOL], false, 5);
    expect(tools).toEqual([{ name: "echo_tool", description: "Echoes input", input_schema: { type: "object", properties: {} } }]);
  });

  test("appends the web_search server tool when enabled, with the configured max_uses", () => {
    const tools = buildAnthropicTools([ECHO_TOOL], true, 3);
    expect(tools).toHaveLength(2);
    expect(tools[1]).toEqual({ type: "web_search_20250305", name: "web_search", max_uses: 3 });
  });

  test("web_search is the only tool when no local tools are registered", () => {
    const tools = buildAnthropicTools([], true, 5);
    expect(tools).toEqual([{ type: "web_search_20250305", name: "web_search", max_uses: 5 }]);
  });
});

function makeResponse(content: unknown[]): Anthropic.Message {
  return { content, stop_reason: "end_turn" } as unknown as Anthropic.Message;
}

describe("fromAnthropicResponse", () => {
  test("concatenates text blocks and collects tool_use as toolCalls", () => {
    const response = makeResponse([
      { type: "text", text: "Hello, " },
      { type: "text", text: "world." },
      { type: "tool_use", id: "call-1", name: "echo_tool", input: { a: 1 } },
    ]);

    const result = fromAnthropicResponse(response);
    expect(result.text).toBe("Hello, world.");
    expect(result.toolCalls).toEqual([{ id: "call-1", toolName: "echo_tool", input: { a: 1 } }]);
    expect(result.serverToolUses).toBeUndefined();
  });

  test("records server_tool_use blocks as serverToolUses", () => {
    const response = makeResponse([
      { type: "server_tool_use", id: "srv-1", name: "web_search", input: { query: "weather today" } },
      { type: "text", text: "It's sunny." },
    ]);

    const result = fromAnthropicResponse(response);
    expect(result.serverToolUses).toEqual(["web_search"]);
    expect(result.text).toBe("It's sunny.");
  });

  test("leaves serverToolUses undefined when no server tool ran", () => {
    const response = makeResponse([{ type: "text", text: "hi" }]);
    const result = fromAnthropicResponse(response);
    expect(result.serverToolUses).toBeUndefined();
  });
});
