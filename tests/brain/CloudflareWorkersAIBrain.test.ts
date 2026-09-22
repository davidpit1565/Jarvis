import { describe, test, expect, afterEach } from "bun:test";
import { CloudflareWorkersAIBrain, fromOpenAIResponse } from "@/core/brain/CloudflareWorkersAIBrain";
import type { ConversationMessage } from "@/types/conversation";

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

describe("CloudflareWorkersAIBrain construction", () => {
  test("requires a Cloudflare account id", () => {
    expect(() => new CloudflareWorkersAIBrain(undefined, "cf-token", { model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" })).toThrow(
      /account id/i
    );
    expect(() => new CloudflareWorkersAIBrain("", "cf-token", { model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" })).toThrow(
      /account id/i
    );
  });

  test("requires a Cloudflare API token", () => {
    expect(() => new CloudflareWorkersAIBrain("acct-1", undefined, { model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" })).toThrow(
      /API token/i
    );
    expect(() => new CloudflareWorkersAIBrain("acct-1", "", { model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" })).toThrow(
      /API token/i
    );
  });

  test("requires a model id — there is no sensible default across 50+ hosted models", () => {
    expect(() => new CloudflareWorkersAIBrain("acct-1", "cf-token", {})).toThrow(/model/i);
    expect(() => new CloudflareWorkersAIBrain("acct-1", "cf-token", { model: "" })).toThrow(/model/i);
  });

  test("constructs when account id, API token, and model are all present", () => {
    expect(
      () => new CloudflareWorkersAIBrain("acct-1", "cf-token", { model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" })
    ).not.toThrow();
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

describe("CloudflareWorkersAIBrain.chat", () => {
  test("POSTs an OpenAI-shaped body to the account-scoped endpoint, with a Bearer token", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    let capturedUrl: string | undefined;
    let capturedHeaders: Record<string, string> | undefined;
    global.fetch = (async (url: unknown, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedBody = JSON.parse(init?.body as string);
      capturedHeaders = init?.headers as Record<string, string>;
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }), { status: 200 });
    }) as unknown as typeof fetch;

    const brain = new CloudflareWorkersAIBrain("acct-1", "cf-token", { model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" });
    const messages: ConversationMessage[] = [{ role: "user", content: "hi" }];
    const result = await brain.chat({ messages, tools: [], context: "You are JARVIS." });

    expect(result.text).toBe("ok");
    expect(capturedUrl).toBe("https://api.cloudflare.com/client/v4/accounts/acct-1/ai/v1/chat/completions");
    expect(capturedHeaders?.Authorization).toBe("Bearer cf-token");
    expect(capturedBody?.model).toBe("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
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

    const brain = new CloudflareWorkersAIBrain("acct-1", "cf-token", { model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" });
    await brain.chat({
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "get_weather", description: "Gets weather", input_schema: { type: "object", properties: {} } }],
    });

    expect(capturedBody?.tools).toEqual([
      { type: "function", function: { name: "get_weather", description: "Gets weather", parameters: { type: "object", properties: {} } } },
    ]);
  });

  test("sends empty string (not null) as content for a tool-calls-only assistant message", async () => {
    // Regression test: found live — Cloudflare Workers AI's OpenAI-compat
    // layer 400s a real tool-call round trip when the assistant message's
    // content is `null` (which Groq/OpenRouter/Ollama all accept per the
    // OpenAI spec), reproduced independently with curl against the real
    // API before fixing. See toOpenAIMessages's own comment.
    let capturedBody: Record<string, unknown> | undefined;
    global.fetch = (async (_url: unknown, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ choices: [{ message: { content: "done" }, finish_reason: "stop" }] }), { status: 200 });
    }) as unknown as typeof fetch;

    const brain = new CloudflareWorkersAIBrain("acct-1", "cf-token", { model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" });
    const messages: ConversationMessage[] = [
      { role: "user", content: "check the studio" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call-1", toolName: "list_reels", input: {} }],
      },
      { role: "tool", toolCallId: "call-1", toolName: "list_reels", content: "[]" },
    ];
    await brain.chat({ messages, tools: [] });

    const assistantMessage = (capturedBody?.messages as Array<Record<string, unknown>>).find((m) => m.role === "assistant");
    expect(assistantMessage?.content).toBe("");
    expect(assistantMessage?.content).not.toBeNull();
  });

  test("retries once on a 503, then succeeds", async () => {
    let attempts = 0;
    global.fetch = (async () => {
      attempts++;
      if (attempts === 1) return new Response("overloaded", { status: 503 });
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }), { status: 200 });
    }) as unknown as typeof fetch;

    const brain = new CloudflareWorkersAIBrain("acct-1", "cf-token", {
      model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      retryDelayMs: 0,
    });
    const result = await brain.chat({ messages: [{ role: "user", content: "hi" }], tools: [] });

    expect(result.text).toBe("ok");
    expect(attempts).toBe(2);
  });

  test("does not retry a 401 (auth failure would fail identically every time) and names what to check", async () => {
    let attempts = 0;
    global.fetch = (async () => {
      attempts++;
      return new Response("invalid token", { status: 401 });
    }) as unknown as typeof fetch;

    const brain = new CloudflareWorkersAIBrain("acct-1", "cf-token", { model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" });
    let thrown: Error | undefined;
    try {
      await brain.chat({ messages: [{ role: "user", content: "hi" }], tools: [] });
    } catch (error) {
      thrown = error as Error;
    }

    expect(attempts).toBe(1);
    expect(thrown?.message).toContain("401");
    expect(thrown?.message).toContain("CLOUDFLARE_API_TOKEN");
  });

  test("a 429 (daily free-tier quota exhausted) surfaces a clear, actionable error naming the daily reset", async () => {
    global.fetch = (async () => new Response("rate limited", { status: 429 })) as unknown as typeof fetch;

    const brain = new CloudflareWorkersAIBrain("acct-1", "cf-token", {
      model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      retryDelayMs: 0,
    });
    let thrown: Error | undefined;
    try {
      await brain.chat({ messages: [{ role: "user", content: "hi" }], tools: [] });
    } catch (error) {
      thrown = error as Error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown?.message).toContain("429");
    expect(thrown?.message.toLowerCase()).toContain("neuron");
    expect(thrown?.message).toContain("00:00 UTC");
  });

  test("surfaces an unreachable endpoint (connection error) as a clear, actionable error, not a crash", async () => {
    global.fetch = (async () => {
      throw new Error("connect ECONNREFUSED");
    }) as unknown as typeof fetch;

    const brain = new CloudflareWorkersAIBrain("acct-1", "cf-token", { model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" });
    let thrown: Error | undefined;
    try {
      await brain.chat({ messages: [{ role: "user", content: "hi" }], tools: [] });
    } catch (error) {
      thrown = error as Error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown?.message).toContain("Could not reach Cloudflare Workers AI");
    expect(thrown?.message).toContain("acct-1");
  });
});
