import { describe, test, expect, afterEach } from "bun:test";
import { GeminiBrain, DEFAULT_GEMINI_MODEL, fromGeminiResponse } from "@/core/brain/GeminiBrain";
import type { ConversationMessage } from "@/types/conversation";

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

describe("fromGeminiResponse", () => {
  test("extracts plain text with no function calls", () => {
    const result = fromGeminiResponse({
      candidates: [{ content: { parts: [{ text: "hello there" }] }, finishReason: "STOP" }],
    });
    expect(result.text).toBe("hello there");
    expect(result.toolCalls).toEqual([]);
    expect(result.stopReason).toBe("STOP");
  });

  test("extracts a function call, synthesizing a call id since Gemini's own functionCall part carries none", () => {
    const result = fromGeminiResponse({
      candidates: [
        {
          content: { parts: [{ functionCall: { name: "get_weather", args: { city: "Tel Aviv" } } }] },
          finishReason: "STOP",
        },
      ],
    });
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.toolName).toBe("get_weather");
    expect(result.toolCalls[0]?.input).toEqual({ city: "Tel Aviv" });
    expect(typeof result.toolCalls[0]?.id).toBe("string");
    expect(result.toolCalls[0]?.id.length).toBeGreaterThan(0);
  });

  test("concatenates multiple text parts and ignores a mixed function-call part when extracting text", () => {
    const result = fromGeminiResponse({
      candidates: [
        {
          content: {
            parts: [{ text: "Checking the weather: " }, { functionCall: { name: "get_weather", args: {} } }],
          },
          finishReason: "STOP",
        },
      ],
    });
    expect(result.text).toBe("Checking the weather: ");
    expect(result.toolCalls).toHaveLength(1);
  });

  test("maps usageMetadata fields, with cache fields honestly zeroed", () => {
    const result = fromGeminiResponse({
      candidates: [{ content: { parts: [{ text: "hi" }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
    });
    expect(result.usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    });
  });

  test("does not throw on a malformed response with no candidates array", () => {
    const result = fromGeminiResponse({} as never);
    expect(result.text).toBe("");
    expect(result.toolCalls).toEqual([]);
    expect(result.stopReason).toBe("unknown");
  });

  test("leaves usage undefined when the provider omits usageMetadata", () => {
    const result = fromGeminiResponse({
      candidates: [{ content: { parts: [{ text: "hi" }] }, finishReason: "STOP" }],
    });
    expect(result.usage).toBeUndefined();
  });

  test("carries the response's modelVersion, for CostTracker's per-model ledger", () => {
    const result = fromGeminiResponse({
      candidates: [{ content: { parts: [{ text: "hi" }] }, finishReason: "STOP" }],
      modelVersion: "gemini-2.0-flash",
    });
    expect(result.model).toBe("gemini-2.0-flash");
  });
});

describe("GeminiBrain.chat", () => {
  test("POSTs Gemini's own contents/systemInstruction shape, authenticated via the x-goog-api-key header", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    let capturedHeaders: Record<string, string> | undefined;
    let capturedUrl: string | undefined;
    global.fetch = (async (url: unknown, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedBody = JSON.parse(init?.body as string);
      capturedHeaders = init?.headers as Record<string, string>;
      return new Response(
        JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }] }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const brain = new GeminiBrain("gem-test-key");
    const messages: ConversationMessage[] = [{ role: "user", content: "hi" }];
    const result = await brain.chat({ messages, tools: [], context: "You are JARVIS." });

    expect(result.text).toBe("ok");
    expect(capturedUrl).toContain("generativelanguage.googleapis.com");
    expect(capturedUrl).toContain(DEFAULT_GEMINI_MODEL);
    // Never leaked into the URL itself — only the header.
    expect(capturedUrl).not.toContain("gem-test-key");
    expect(capturedHeaders?.["x-goog-api-key"]).toBe("gem-test-key");
    expect(capturedBody?.systemInstruction).toEqual({ parts: [{ text: "You are JARVIS." }] });
    expect(capturedBody?.contents).toEqual([{ role: "user", parts: [{ text: "hi" }] }]);
  });

  test("converts an attached image into an inlineData part", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    global.fetch = (async (_url: unknown, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(
        JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }] }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const brain = new GeminiBrain("gem-test-key");
    const messages: ConversationMessage[] = [
      { role: "user", content: "what's this?", images: [{ mediaType: "image/png", data: "abc123" }] },
    ];
    await brain.chat({ messages, tools: [] });

    const contents = capturedBody?.contents as Array<{ parts: unknown[] }>;
    expect(contents[0]?.parts).toEqual([
      { inlineData: { mimeType: "image/png", data: "abc123" } },
      { text: "what's this?" },
    ]);
  });

  test("converts tool definitions into Gemini's functionDeclarations shape", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    global.fetch = (async (_url: unknown, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(
        JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }] }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const brain = new GeminiBrain("gem-test-key");
    await brain.chat({
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "get_weather", description: "Gets weather", input_schema: { type: "object", properties: {} } }],
    });

    expect(capturedBody?.tools).toEqual([
      {
        functionDeclarations: [
          { name: "get_weather", description: "Gets weather", parameters: { type: "object", properties: {} } },
        ],
      },
    ]);
  });

  test("sends an assistant tool call as a model-role functionCall part, and the tool result back as a user-role functionResponse part", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    global.fetch = (async (_url: unknown, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(
        JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }] }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const brain = new GeminiBrain("gem-test-key");
    const messages: ConversationMessage[] = [
      { role: "user", content: "what's the weather in Tel Aviv?" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call-1", toolName: "get_weather", input: { city: "Tel Aviv" } }],
      },
      { role: "tool", toolCallId: "call-1", toolName: "get_weather", content: "Sunny, 28C" },
    ];
    await brain.chat({ messages, tools: [] });

    const contents = capturedBody?.contents as Array<{ role: string; parts: unknown[] }>;
    expect(contents[1]).toEqual({
      role: "model",
      parts: [{ functionCall: { name: "get_weather", args: { city: "Tel Aviv" } } }],
    });
    expect(contents[2]).toEqual({
      role: "user",
      parts: [{ functionResponse: { name: "get_weather", response: { content: "Sunny, 28C" } } }],
    });
  });

  test("retries once on a 429, then succeeds", async () => {
    let attempts = 0;
    global.fetch = (async () => {
      attempts++;
      if (attempts === 1) return new Response("rate limited", { status: 429 });
      return new Response(
        JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }] }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const brain = new GeminiBrain("gem-test-key", { retryDelayMs: 0 });
    const result = await brain.chat({ messages: [{ role: "user", content: "hi" }], tools: [] });

    expect(result.text).toBe("ok");
    expect(attempts).toBe(2);
  });

  test("does not retry a 401/403-style auth failure (would fail identically every time)", async () => {
    let attempts = 0;
    global.fetch = (async () => {
      attempts++;
      return new Response(JSON.stringify({ error: { code: 403, message: "API key not valid" } }), { status: 403 });
    }) as unknown as typeof fetch;

    const brain = new GeminiBrain("bad-key");
    let thrown: Error | undefined;
    try {
      await brain.chat({ messages: [{ role: "user", content: "hi" }], tools: [] });
    } catch (error) {
      thrown = error as Error;
    }

    expect(attempts).toBe(1);
    expect(thrown?.message).toContain("403");
  });

  test("a 503 that never recovers surfaces a clear error after exhausting retries", async () => {
    global.fetch = (async () =>
      new Response(JSON.stringify({ error: { code: 503, message: "model overloaded" } }), { status: 503 })) as unknown as typeof fetch;

    const brain = new GeminiBrain("gem-test-key", { retryDelayMs: 0 });
    await expect(brain.chat({ messages: [{ role: "user", content: "hi" }], tools: [] })).rejects.toThrow("503");
  });

  test("honors a custom model option", async () => {
    let capturedUrl: string | undefined;
    global.fetch = (async (url: unknown) => {
      capturedUrl = String(url);
      return new Response(
        JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }] }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const brain = new GeminiBrain("gem-test-key", { model: "gemini-1.5-flash" });
    await brain.chat({ messages: [{ role: "user", content: "hi" }], tools: [] });

    expect(capturedUrl).toContain("gemini-1.5-flash");
  });
});

describe("GeminiBrain's free-tier nature", () => {
  // Unlike OpenRouterBrain, which hard-refuses to construct against a
  // non-":free"-suffixed model id (OpenRouterPaidModelError) because
  // OpenRouter is a mixed paid/free marketplace with a per-model price
  // tag, Gemini's free tier is scoped to the API key/project itself — any
  // model id is exactly as free (or not) as the key's own billing status,
  // which this class has no way to introspect from a model id string. So
  // there is deliberately no analogous "refuse a paid model" check or
  // error class here (see GeminiBrain's own doc comment) — this test
  // documents that absence explicitly, rather than silently having no
  // equivalent coverage to OpenRouterBrain's "refuses a non-:free model"
  // test.
  test("constructs successfully against any model id — there is no per-model free/paid gate to enforce", () => {
    expect(() => new GeminiBrain("key")).not.toThrow();
    expect(() => new GeminiBrain("key", { model: "gemini-1.5-pro" })).not.toThrow();
    expect(() => new GeminiBrain("key", { model: "some-made-up-model-id" })).not.toThrow();
  });

  test("DEFAULT_GEMINI_MODEL is a non-empty model id", () => {
    expect(typeof DEFAULT_GEMINI_MODEL).toBe("string");
    expect(DEFAULT_GEMINI_MODEL.length).toBeGreaterThan(0);
  });
});
