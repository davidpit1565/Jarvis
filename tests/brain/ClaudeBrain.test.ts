import { describe, test, expect } from "bun:test";
import { ClaudeBrain, buildAnthropicTools, fromAnthropicResponse } from "@/core/brain/ClaudeBrain";
import type { ToolDefinition } from "@/types/tools";
import type Anthropic from "@anthropic-ai/sdk";

describe("ClaudeBrain reliability tuning", () => {
  test("sets an explicit retry count and timeout on the underlying Anthropic client, rather than the SDK's own defaults", () => {
    const brain = new ClaudeBrain("sk-ant-test-key");
    const client = (brain as unknown as { client: Anthropic }).client;
    expect(client.maxRetries).toBe(4);
    expect(client.timeout).toBe(30_000);
  });
});

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

  test("omits web_fetch when disabled (the default)", () => {
    const tools = buildAnthropicTools([ECHO_TOOL], false, 5);
    expect(tools.some((t) => "name" in t && t.name === "web_fetch")).toBe(false);
  });

  test("appends the web_fetch server tool when enabled, with the configured max_uses", () => {
    const tools = buildAnthropicTools([ECHO_TOOL], false, 5, true, 7);
    expect(tools).toHaveLength(2);
    expect(tools[1]).toEqual({ type: "web_fetch_20250910", name: "web_fetch", max_uses: 7 });
  });

  test("web_search and web_fetch can both be enabled together", () => {
    const tools = buildAnthropicTools([], true, 5, true, 5);
    expect(tools).toEqual([
      { type: "web_search_20250305", name: "web_search", max_uses: 5 },
      { type: "web_fetch_20250910", name: "web_fetch", max_uses: 5 },
    ]);
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
