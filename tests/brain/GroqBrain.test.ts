import { describe, test, expect, afterEach } from "bun:test";
import {
  GroqBrain,
  DEFAULT_GROQ_MODEL,
  fromOpenAIResponse,
  acceptNullForOptionalParams,
} from "@/core/brain/GroqBrain";
import type { ConversationMessage } from "@/types/conversation";

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

describe("fromOpenAIResponse", () => {
  test("extracts plain text with no tool calls", () => {
    const result = fromOpenAIResponse({
      choices: [{ message: { content: "hello there" }, finish_reason: "stop" }],
    });
    expect(result.text).toBe("hello there");
    expect(result.toolCalls).toEqual([]);
    expect(result.stopReason).toBe("stop");
  });

  test("extracts tool calls with parsed JSON arguments", () => {
    const result = fromOpenAIResponse({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [{ id: "call-1", type: "function", function: { name: "get_weather", arguments: '{"city":"Tel Aviv"}' } }],
          },
          finish_reason: "tool_calls",
        },
      ],
    });
    expect(result.text).toBe("");
    expect(result.toolCalls).toEqual([{ id: "call-1", toolName: "get_weather", input: { city: "Tel Aviv" } }]);
  });

  test("falls back to an empty input object on malformed tool-call JSON, rather than throwing", () => {
    const result = fromOpenAIResponse({
      choices: [
        {
          message: { content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "x", arguments: "not json" } }] },
          finish_reason: "tool_calls",
        },
      ],
    });
    expect(result.toolCalls).toEqual([{ id: "call-1", toolName: "x", input: {} }]);
  });

  test("maps usage fields, with cache fields honestly zeroed", () => {
    const result = fromOpenAIResponse({
      choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
    expect(result.usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    });
  });

  test("does not throw on a malformed response with no choices array", () => {
    const result = fromOpenAIResponse({} as never);
    expect(result.text).toBe("");
    expect(result.toolCalls).toEqual([]);
    expect(result.stopReason).toBe("unknown");
  });

  test("carries the response's model, for CostTracker's per-model ledger", () => {
    const result = fromOpenAIResponse({
      choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
      model: "llama-3.3-70b-versatile",
    });
    expect(result.model).toBe("llama-3.3-70b-versatile");
  });

  test("leaves usage undefined when the provider omits it", () => {
    const result = fromOpenAIResponse({ choices: [{ message: { content: "hi" }, finish_reason: "stop" }] });
    expect(result.usage).toBeUndefined();
  });
});

describe("GroqBrain.chat", () => {
  test("POSTs an OpenAI-shaped body with the system context as a leading system message", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    let capturedAuth: string | undefined;
    global.fetch = (async (_url: unknown, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      capturedAuth = (init?.headers as Record<string, string>)?.Authorization;
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const brain = new GroqBrain("gsk-test-key");
    const messages: ConversationMessage[] = [{ role: "user", content: "hi" }];
    const result = await brain.chat({ messages, tools: [], context: "You are JARVIS." });

    expect(result.text).toBe("ok");
    expect(capturedAuth).toBe("Bearer gsk-test-key");
    expect(capturedBody?.model).toBe(DEFAULT_GROQ_MODEL);
    expect(capturedBody?.messages).toEqual([
      { role: "system", content: "You are JARVIS." },
      { role: "user", content: "hi" },
    ]);
  });

  test("converts an attached image into an OpenAI image_url content block", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    global.fetch = (async (_url: unknown, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }), { status: 200 });
    }) as unknown as typeof fetch;

    const brain = new GroqBrain("gsk-test-key");
    const messages: ConversationMessage[] = [
      { role: "user", content: "what's this?", images: [{ mediaType: "image/png", data: "abc123" }] },
    ];
    await brain.chat({ messages, tools: [] });

    const sentMessages = capturedBody?.messages as Array<{ content: unknown }>;
    expect(sentMessages[0]?.content).toEqual([
      { type: "image_url", image_url: { url: "data:image/png;base64,abc123" } },
      { type: "text", text: "what's this?" },
    ]);
  });

  test("converts tool definitions into OpenAI function-tool shape", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    global.fetch = (async (_url: unknown, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }), { status: 200 });
    }) as unknown as typeof fetch;

    const brain = new GroqBrain("gsk-test-key");
    await brain.chat({
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "get_weather", description: "Gets weather", input_schema: { type: "object", properties: {} } }],
    });

    expect(capturedBody?.tools).toEqual([
      { type: "function", function: { name: "get_weather", description: "Gets weather", parameters: { type: "object", properties: {} } } },
    ]);
  });

  test("retries once on a 429, then succeeds", async () => {
    let attempts = 0;
    global.fetch = (async () => {
      attempts++;
      if (attempts === 1) return new Response("rate limited", { status: 429 });
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }), { status: 200 });
    }) as unknown as typeof fetch;

    const brain = new GroqBrain("gsk-test-key", { retryDelayMs: 0 });
    const result = await brain.chat({ messages: [{ role: "user", content: "hi" }], tools: [] });

    expect(result.text).toBe("ok");
    expect(attempts).toBe(2);
  });

  test("does not retry a 401 (auth failure would fail identically every time)", async () => {
    let attempts = 0;
    global.fetch = (async () => {
      attempts++;
      return new Response("invalid api key", { status: 401 });
    }) as unknown as typeof fetch;

    const brain = new GroqBrain("bad-key");
    let thrown: Error | undefined;
    try {
      await brain.chat({ messages: [{ role: "user", content: "hi" }], tools: [] });
    } catch (error) {
      thrown = error as Error;
    }

    expect(attempts).toBe(1);
    expect(thrown?.message).toContain("401");
  });

  test("honors a custom model option", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    global.fetch = (async (_url: unknown, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }), { status: 200 });
    }) as unknown as typeof fetch;

    const brain = new GroqBrain("gsk-test-key", { model: "llama-3.1-8b-instant" });
    await brain.chat({ messages: [{ role: "user", content: "hi" }], tools: [] });

    expect(capturedBody?.model).toBe("llama-3.1-8b-instant");
  });
});

describe("acceptNullForOptionalParams", () => {
  test("widens an optional parameter so an explicit null passes Groq's validator", () => {
    // Groq rejects the entire completion with a 400 when the model answers
    // "no deviceId" with `{"deviceId": null}` against `"type": "string"`,
    // which took every device tool (all of which have an optional deviceId)
    // out of service on this provider.
    const widened = acceptNullForOptionalParams({
      type: "object",
      properties: { deviceId: { type: "string", description: "Defaults to the primary device." } },
    });

    expect(widened.properties.deviceId).toEqual({
      type: ["string", "null"],
      description: "Defaults to the primary device.",
    });
  });

  test("leaves required parameters strict", () => {
    const widened = acceptNullForOptionalParams({
      type: "object",
      properties: { query: { type: "string" }, limit: { type: "number" } },
      required: ["query"],
    });

    expect(widened.properties.query).toEqual({ type: "string" });
    expect(widened.properties.limit).toEqual({ type: ["number", "null"] });
    expect(widened.required).toEqual(["query"]);
  });

  test("returns the original schema untouched when there is nothing to widen", () => {
    const schema = {
      type: "object" as const,
      properties: { query: { type: "string" } },
      required: ["query"],
    };

    expect(acceptNullForOptionalParams(schema)).toBe(schema);
  });

  test("preserves a property that already expresses its own nullability", () => {
    const widened = acceptNullForOptionalParams({
      type: "object",
      properties: {
        union: { type: ["string", "null"] },
        composed: { anyOf: [{ type: "string" }, { type: "number" }] },
      },
    });

    expect(widened.properties.union).toEqual({ type: ["string", "null"] });
    expect(widened.properties.composed).toEqual({ anyOf: [{ type: "string" }, { type: "number" }] });
  });

  test("sends the widened schema on the wire", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    global.fetch = (async (_url: unknown, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const brain = new GroqBrain("gsk-test-key");
    await brain.chat({
      messages: [{ role: "user", content: "which app is frontmost?" }],
      tools: [
        {
          name: "get_active_application",
          description: "Returns the frontmost application.",
          input_schema: { type: "object", properties: { deviceId: { type: "string" } } },
        },
      ],
    });

    const tools = capturedBody?.tools as Array<{ function: { parameters: { properties: Record<string, unknown> } } }>;
    expect(tools[0]?.function.parameters.properties.deviceId).toEqual({ type: ["string", "null"] });
  });
});
