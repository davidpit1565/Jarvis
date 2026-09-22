import { describe, test, expect, afterEach } from "bun:test";
import { OllamaEmbeddingsClient, OllamaEmbeddingsError } from "@/core/embeddings/OllamaEmbeddingsClient";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

describe("OllamaEmbeddingsClient.embed", () => {
  test("returns the embedding array from a successful response", async () => {
    let capturedUrl: string | undefined;
    let capturedBody: string | undefined;
    global.fetch = (async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedBody = init?.body as string;
      return new Response(JSON.stringify({ embedding: [0.1, 0.2, 0.3] }), { status: 200 });
    }) as unknown as typeof fetch;

    const client = new OllamaEmbeddingsClient({ model: "nomic-embed-text" });
    const embedding = await client.embed("dentist appointment");

    expect(embedding).toEqual([0.1, 0.2, 0.3]);
    expect(capturedUrl).toBe("http://localhost:11434/api/embeddings");
    expect(JSON.parse(capturedBody!)).toEqual({ model: "nomic-embed-text", prompt: "dentist appointment" });
  });

  test("uses a custom base URL when given, with no trailing slash duplication", async () => {
    let capturedUrl: string | undefined;
    global.fetch = (async (url: string) => {
      capturedUrl = url;
      return new Response(JSON.stringify({ embedding: [1] }), { status: 200 });
    }) as unknown as typeof fetch;

    const client = new OllamaEmbeddingsClient({ baseUrl: "http://my-ollama-box:11434/", model: "nomic-embed-text" });
    await client.embed("x");

    expect(capturedUrl).toBe("http://my-ollama-box:11434/api/embeddings");
  });

  test("throws OllamaEmbeddingsError (not a crash) when the server is unreachable", async () => {
    global.fetch = (async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:11434");
    }) as unknown as typeof fetch;

    const client = new OllamaEmbeddingsClient({ model: "nomic-embed-text" });

    let caught: unknown;
    try {
      await client.embed("hello");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(OllamaEmbeddingsError);
    expect((caught as Error).message).toContain("localhost:11434");
  });

  test("throws OllamaEmbeddingsError on a non-2xx response (e.g. model not pulled)", async () => {
    global.fetch = (async () => new Response("model not found", { status: 404 })) as unknown as typeof fetch;

    const client = new OllamaEmbeddingsClient({ model: "nomic-embed-text" });

    await expect(client.embed("hello")).rejects.toBeInstanceOf(OllamaEmbeddingsError);
    await expect(client.embed("hello")).rejects.toThrow(/404/);
  });

  test("throws OllamaEmbeddingsError when the response has no usable embedding array", async () => {
    global.fetch = (async () => new Response(JSON.stringify({ oops: true }), { status: 200 })) as unknown as typeof fetch;

    const client = new OllamaEmbeddingsClient({ model: "nomic-embed-text" });

    await expect(client.embed("hello")).rejects.toBeInstanceOf(OllamaEmbeddingsError);
  });

  test("throws OllamaEmbeddingsError on invalid JSON in the response", async () => {
    global.fetch = (async () => new Response("not json", { status: 200 })) as unknown as typeof fetch;

    const client = new OllamaEmbeddingsClient({ model: "nomic-embed-text" });

    await expect(client.embed("hello")).rejects.toBeInstanceOf(OllamaEmbeddingsError);
  });
});
