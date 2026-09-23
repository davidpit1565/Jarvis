import { describe, test, expect, afterEach } from "bun:test";
import {
  OpenRouterBrain,
  OpenRouterPaidModelError,
  DEFAULT_OPENROUTER_MODEL,
  fromOpenAIResponse,
} from "@/core/brain/OpenRouterBrain";
import type { ConversationMessage } from "@/types/conversation";

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

describe("OpenRouterBrain construction", () => {
  test("accepts the default (:free-suffixed) model", () => {
    expect(() => new OpenRouterBrain("key")).not.toThrow();
  });

  test("accepts an explicit :free model", () => {
    expect(() => new OpenRouterBrain("key", { model: "some/model:free" })).not.toThrow();
  });

  test("refuses a non-:free model with OpenRouterPaidModelError, never silently accepting it", () => {
    expect(() => new OpenRouterBrain("key", { model: "openai/gpt-4o" })).toThrow(OpenRouterPaidModelError);
  });

  test("DEFAULT_OPENROUTER_MODEL itself carries the :free suffix", () => {
    expect(DEFAULT_OPENROUTER_MODEL.endsWith(":free")).toBe(true);
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

  test("carries the response's model, for CostTracker's per-model ledger", () => {
    const result = fromOpenAIResponse({
      choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
      model: "meta-llama/llama-3.1-8b-instruct:free",
    });
    expect(result.model).toBe("meta-llama/llama-3.1-8b-instruct:free");
  });
});

describe("OpenRouterBrain.chat", () => {
  test("POSTs an OpenAI-shaped body against the free-model default, with attribution headers", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    let capturedAuth: string | undefined;
    let capturedUrl: string | undefined;
    global.fetch = (async (url: unknown, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedBody = JSON.parse(init?.body as string);
      capturedAuth = (init?.headers as Record<string, string>)?.Authorization;
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }), { status: 200 });
    }) as unknown as typeof fetch;

    const brain = new OpenRouterBrain("or-test-key");
    const messages: ConversationMessage[] = [{ role: "user", content: "hi" }];
    const result = await brain.chat({ messages, tools: [], context: "You are JARVIS." });

    expect(result.text).toBe("ok");
    expect(capturedUrl).toContain("openrouter.ai");
    expect(capturedAuth).toBe("Bearer or-test-key");
    expect(capturedBody?.model).toBe(DEFAULT_OPENROUTER_MODEL);
    expect(capturedBody?.messages).toEqual([
      { role: "system", content: "You are JARVIS." },
      { role: "user", content: "hi" },
    ]);
  });

  test("converts tool definitions into OpenAI function-tool shape", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    global.fetch = (async (_url: unknown, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }), { status: 200 });
    }) as unknown as typeof fetch;

    const brain = new OpenRouterBrain("or-test-key");
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

    const brain = new OpenRouterBrain("or-test-key", { retryDelayMs: 0 });
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

    const brain = new OpenRouterBrain("bad-key");
    let thrown: Error | undefined;
    try {
      await brain.chat({ messages: [{ role: "user", content: "hi" }], tools: [] });
    } catch (error) {
      thrown = error as Error;
    }

    expect(attempts).toBe(1);
    expect(thrown?.message).toContain("401");
  });

  test("treats an HTTP 200 carrying OpenRouter's error envelope as a failed call, not an empty reply", async () => {
    let attempts = 0;
    global.fetch = (async () => {
      attempts++;
      // Verbatim shape OpenRouter returns when the upstream provider is
      // down — status 200, no `choices` at all.
      return new Response(
        JSON.stringify({
          id: "gen-1",
          error: { message: "Upstream error from Nvidia: Service temporarily overloaded", code: 503 },
        }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const brain = new OpenRouterBrain("or-test-key", { retryDelayMs: 0 });
    let thrown: Error | undefined;
    try {
      await brain.chat({ messages: [{ role: "user", content: "hi" }], tools: [] });
    } catch (error) {
      thrown = error as Error;
    }

    // An embedded 503 is retried on exactly the same terms as a real HTTP
    // 503 would be, then surfaces as an error the router can fall back on.
    expect(attempts).toBeGreaterThan(1);
    expect(thrown?.message).toContain("503");
    expect(thrown?.message).toContain("Service temporarily overloaded");
  });

  test("retries an embedded 503 and returns the reply once the upstream recovers", async () => {
    let attempts = 0;
    global.fetch = (async () => {
      attempts++;
      if (attempts === 1) {
        return new Response(JSON.stringify({ error: { message: "overloaded", code: 503 } }), { status: 200 });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }), { status: 200 });
    }) as unknown as typeof fetch;

    const brain = new OpenRouterBrain("or-test-key", { retryDelayMs: 0 });
    const result = await brain.chat({ messages: [{ role: "user", content: "hi" }], tools: [] });

    expect(result.text).toBe("ok");
    expect(attempts).toBe(2);
  });

  test("a 200 with an empty choices array fails rather than returning a blank answer", async () => {
    global.fetch = (async () => new Response(JSON.stringify({ choices: [] }), { status: 200 })) as unknown as typeof fetch;

    const brain = new OpenRouterBrain("or-test-key", { retryDelayMs: 0 });
    await expect(brain.chat({ messages: [{ role: "user", content: "hi" }], tools: [] })).rejects.toThrow("no choices");
  });
});
