import { describe, test, expect, afterEach } from "bun:test";
import { OllamaBrain, DEFAULT_OLLAMA_BASE_URL, fromOpenAIResponse } from "@/core/brain/OllamaBrain";
import type { ConversationMessage } from "@/types/conversation";

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

describe("OllamaBrain construction", () => {
  test("requires a model — there is no sensible default to guess", () => {
    expect(() => new OllamaBrain(undefined, {})).toThrow();
    expect(() => new OllamaBrain(undefined, { model: "" })).toThrow();
  });

  test("constructs with no API key at all — Ollama's default local setup has no auth", () => {
    expect(() => new OllamaBrain(undefined, { model: "qwen2.5" })).not.toThrow();
  });

  test("constructs with an optional bearer token for a proxied setup", () => {
    expect(() => new OllamaBrain("proxy-token", { model: "qwen2.5" })).not.toThrow();
  });

  test("DEFAULT_OLLAMA_BASE_URL is Ollama's real default local port", () => {
    expect(DEFAULT_OLLAMA_BASE_URL).toBe("http://localhost:11434");
  });
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
    expect(result.toolCalls).toEqual([{ id: "call-1", toolName: "get_weather", input: { city: "Tel Aviv" } }]);
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
});

describe("OllamaBrain.chat", () => {
  test("POSTs an OpenAI-shaped body to the local server, with no Authorization header by default", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    let capturedUrl: string | undefined;
    let capturedHeaders: Record<string, string> | undefined;
    global.fetch = (async (url: unknown, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedBody = JSON.parse(init?.body as string);
      capturedHeaders = init?.headers as Record<string, string>;
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }), { status: 200 });
    }) as unknown as typeof fetch;

    const brain = new OllamaBrain(undefined, { model: "qwen2.5" });
    const messages: ConversationMessage[] = [{ role: "user", content: "hi" }];
    const result = await brain.chat({ messages, tools: [], context: "You are JARVIS." });

    expect(result.text).toBe("ok");
    expect(capturedUrl).toBe(`${DEFAULT_OLLAMA_BASE_URL}/v1/chat/completions`);
    expect(capturedHeaders?.Authorization).toBeUndefined();
    expect(capturedBody?.model).toBe("qwen2.5");
    expect(capturedBody?.messages).toEqual([
      { role: "system", content: "You are JARVIS." },
      { role: "user", content: "hi" },
    ]);
  });

  test("sends an Authorization header when an optional bearer token is configured", async () => {
    let capturedAuth: string | undefined;
    global.fetch = (async (_url: unknown, init?: RequestInit) => {
      capturedAuth = (init?.headers as Record<string, string>)?.Authorization;
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }), { status: 200 });
    }) as unknown as typeof fetch;

    const brain = new OllamaBrain("proxy-token", { model: "qwen2.5" });
    await brain.chat({ messages: [{ role: "user", content: "hi" }], tools: [] });

    expect(capturedAuth).toBe("Bearer proxy-token");
  });

  test("converts tool definitions into OpenAI function-tool shape", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    global.fetch = (async (_url: unknown, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }), { status: 200 });
    }) as unknown as typeof fetch;

    const brain = new OllamaBrain(undefined, { model: "qwen2.5" });
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

    const brain = new OllamaBrain(undefined, { model: "qwen2.5", retryDelayMs: 0 });
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

    const brain = new OllamaBrain(undefined, { model: "qwen2.5" });
    let thrown: Error | undefined;
    try {
      await brain.chat({ messages: [{ role: "user", content: "hi" }], tools: [] });
    } catch (error) {
      thrown = error as Error;
    }

    expect(attempts).toBe(1);
    expect(thrown?.message).toContain("401");
  });

  test("surfaces an unreachable server (connection refused) as a clear, actionable error, not a crash", async () => {
    global.fetch = (async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:11434");
    }) as unknown as typeof fetch;

    const brain = new OllamaBrain(undefined, { model: "qwen2.5" });
    let thrown: Error | undefined;
    try {
      await brain.chat({ messages: [{ role: "user", content: "hi" }], tools: [] });
    } catch (error) {
      thrown = error as Error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown?.message).toContain("Could not reach the Ollama server");
    expect(thrown?.message).toContain(DEFAULT_OLLAMA_BASE_URL);
  });

  test("surfaces a request timeout as the same clear, actionable error", async () => {
    global.fetch = (async (_url: unknown, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        (init?.signal as AbortSignal | undefined)?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted", "AbortError"));
        });
      });
    }) as unknown as typeof fetch;

    const brain = new OllamaBrain(undefined, { model: "qwen2.5", timeoutMs: 5 });
    let thrown: Error | undefined;
    try {
      await brain.chat({ messages: [{ role: "user", content: "hi" }], tools: [] });
    } catch (error) {
      thrown = error as Error;
    }

    expect(thrown?.message).toContain("Could not reach the Ollama server");
  });
});
