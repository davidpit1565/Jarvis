import { describe, test, expect } from "bun:test";
import {
  ClaudeBrain,
  buildAnthropicTools,
  fromAnthropicResponse,
  isRetryableWithFallback,
  toAnthropicMessages,
} from "@/core/brain/ClaudeBrain";
import type { ToolDefinition } from "@/types/tools";
import type { ConversationMessage } from "@/types/conversation";
import Anthropic from "@anthropic-ai/sdk";

describe("ClaudeBrain reliability tuning", () => {
  test("sets an explicit retry count and timeout on the underlying Anthropic client, rather than the SDK's own defaults", () => {
    const brain = new ClaudeBrain("sk-ant-test-key");
    const client = (brain as unknown as { client: Anthropic }).client;
    expect(client.maxRetries).toBe(4);
    expect(client.timeout).toBe(30_000);
  });

  test("defaults to the real Anthropic API", () => {
    const brain = new ClaudeBrain("sk-ant-test-key");
    expect(brain.baseUrl).toBe("https://api.anthropic.com");
  });

  test("honors an explicit baseUrl override", () => {
    const brain = new ClaudeBrain("sk-ant-test-key", { baseUrl: "http://localhost:20128" });
    expect(brain.baseUrl).toBe("http://localhost:20128");
  });

  test("accepts a fallbackModel option without throwing", () => {
    expect(() => new ClaudeBrain("sk-ant-test-key", { fallbackModel: "claude-haiku-4-5-20251001" })).not.toThrow();
  });

  test("never picks up the ambient ANTHROPIC_BASE_URL env var on its own", () => {
    const original = process.env.ANTHROPIC_BASE_URL;
    process.env.ANTHROPIC_BASE_URL = "http://some-unrelated-local-proxy:9999";
    try {
      const brain = new ClaudeBrain("sk-ant-test-key");
      expect(brain.baseUrl).toBe("https://api.anthropic.com");
    } finally {
      if (original === undefined) delete process.env.ANTHROPIC_BASE_URL;
      else process.env.ANTHROPIC_BASE_URL = original;
    }
  });
});

describe("isRetryableWithFallback", () => {
  test("is true for 429 (rate limited)", () => {
    expect(isRetryableWithFallback(new Anthropic.APIError(429, undefined, "rate limited", undefined))).toBe(true);
  });

  test("is true for 503/529 (overloaded)", () => {
    expect(isRetryableWithFallback(new Anthropic.APIError(503, undefined, "overloaded", undefined))).toBe(true);
    expect(isRetryableWithFallback(new Anthropic.APIError(529, undefined, "overloaded", undefined))).toBe(true);
  });

  test("is false for a 400 (bad request — a fallback model would fail identically)", () => {
    expect(isRetryableWithFallback(new Anthropic.APIError(400, undefined, "bad request", undefined))).toBe(false);
  });

  test("is false for a non-APIError", () => {
    expect(isRetryableWithFallback(new Error("something else"))).toBe(false);
    expect(isRetryableWithFallback("not even an error")).toBe(false);
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

function makeResponse(content: unknown[], usage: Partial<Anthropic.Usage> = {}): Anthropic.Message {
  return {
    content,
    stop_reason: "end_turn",
    usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, ...usage },
  } as unknown as Anthropic.Message;
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

  test("carries token usage from the provider's response", () => {
    const response = makeResponse([{ type: "text", text: "hi" }], {
      input_tokens: 123,
      output_tokens: 45,
      cache_creation_input_tokens: 6,
      cache_read_input_tokens: 78,
    });

    const result = fromAnthropicResponse(response);
    expect(result.usage).toEqual({
      inputTokens: 123,
      outputTokens: 45,
      cacheCreationInputTokens: 6,
      cacheReadInputTokens: 78,
    });
  });

  test("defaults cache token fields to 0 when the provider omits them", () => {
    const response = makeResponse([{ type: "text", text: "hi" }], {
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
    });

    const result = fromAnthropicResponse(response);
    expect(result.usage?.cacheCreationInputTokens).toBe(0);
    expect(result.usage?.cacheReadInputTokens).toBe(0);
  });

  test("leaves serverToolUses undefined when no server tool ran", () => {
    const response = makeResponse([{ type: "text", text: "hi" }]);
    const result = fromAnthropicResponse(response);
    expect(result.serverToolUses).toBeUndefined();
  });
});

describe("toAnthropicMessages (vision/image support)", () => {
  test("sends a plain string for a text-only user turn, unchanged from before images existed", () => {
    const messages: ConversationMessage[] = [{ role: "user", content: "hello" }];
    const [result] = toAnthropicMessages(messages);
    expect(result?.content).toBe("hello");
  });

  test("builds an image content block plus a trailing text block for a turn with one image", () => {
    const messages: ConversationMessage[] = [
      {
        role: "user",
        content: "what's in this photo?",
        images: [{ mediaType: "image/png", data: "base64data" }],
      },
    ];
    const [result] = toAnthropicMessages(messages);

    expect(Array.isArray(result?.content)).toBe(true);
    const content = result!.content as Anthropic.ContentBlockParam[];
    expect(content).toHaveLength(2);
    expect(content[0]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "base64data" },
    });
    expect(content[1]).toEqual({ type: "text", text: "what's in this photo?" });
  });

  test("omits the trailing text block when the turn has an image but no caption text", () => {
    const messages: ConversationMessage[] = [
      { role: "user", content: "", images: [{ mediaType: "image/jpeg", data: "abc" }] },
    ];
    const [result] = toAnthropicMessages(messages);

    const content = result!.content as Anthropic.ContentBlockParam[];
    expect(content).toHaveLength(1);
    expect(content[0]?.type).toBe("image");
  });

  test("builds one image block per attached image, in order", () => {
    const messages: ConversationMessage[] = [
      {
        role: "user",
        content: "compare these",
        images: [
          { mediaType: "image/jpeg", data: "first" },
          { mediaType: "image/webp", data: "second" },
        ],
      },
    ];
    const [result] = toAnthropicMessages(messages);

    const content = result!.content as Anthropic.ContentBlockParam[];
    expect(content).toHaveLength(3);
    expect((content[0] as Anthropic.ImageBlockParam).source).toEqual({
      type: "base64",
      media_type: "image/jpeg",
      data: "first",
    });
    expect((content[1] as Anthropic.ImageBlockParam).source).toEqual({
      type: "base64",
      media_type: "image/webp",
      data: "second",
    });
    expect(content[2]).toEqual({ type: "text", text: "compare these" });
  });

  test("an empty images array behaves the same as no images at all", () => {
    const messages: ConversationMessage[] = [{ role: "user", content: "hi", images: [] }];
    const [result] = toAnthropicMessages(messages);
    expect(result?.content).toBe("hi");
  });
});
