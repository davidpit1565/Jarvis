import { describe, test, expect, afterEach } from "bun:test";
import { CloudflareImageClient, DEFAULT_IMAGE_MODEL } from "@/images/CloudflareImageClient";

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

describe("CloudflareImageClient construction", () => {
  test("requires a Cloudflare account id", () => {
    expect(() => new CloudflareImageClient(undefined, "cf-token")).toThrow(/account id/i);
    expect(() => new CloudflareImageClient("", "cf-token")).toThrow(/account id/i);
  });

  test("requires a Cloudflare API token", () => {
    expect(() => new CloudflareImageClient("acct-1", undefined)).toThrow(/API token/i);
    expect(() => new CloudflareImageClient("acct-1", "")).toThrow(/API token/i);
  });

  test("constructs when account id and API token are both present, with no model required", () => {
    expect(() => new CloudflareImageClient("acct-1", "cf-token")).not.toThrow();
  });
});

describe("CloudflareImageClient.generateImage", () => {
  test("posts to the ai/run endpoint for the default flux-1-schnell model and returns the base64 image", async () => {
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;
    global.fetch = (async (url: unknown, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedInit = init;
      return new Response(JSON.stringify({ result: { image: "base64bytes" }, success: true, errors: [] }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    const client = new CloudflareImageClient("acct-1", "cf-token");
    const result = await client.generateImage("a cyberpunk cat");

    expect(capturedUrl).toBe(`https://api.cloudflare.com/client/v4/accounts/acct-1/ai/run/${DEFAULT_IMAGE_MODEL}`);
    expect(capturedInit?.method).toBe("POST");
    expect((capturedInit?.headers as Record<string, string>).Authorization).toBe("Bearer cf-token");
    const body = JSON.parse(capturedInit?.body as string);
    expect(body.prompt).toBe("a cyberpunk cat");
    expect(body.steps).toBe(4); // default steps
    expect(result).toEqual({ base64: "base64bytes", mimeType: "image/jpeg" });
  });

  test("honors a custom model id", async () => {
    let capturedUrl: string | undefined;
    global.fetch = (async (url: unknown) => {
      capturedUrl = String(url);
      return new Response(JSON.stringify({ result: { image: "x" }, success: true, errors: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    const client = new CloudflareImageClient("acct-1", "cf-token", { model: "@cf/some/other-model" });
    await client.generateImage("sunset");

    expect(capturedUrl).toContain("/ai/run/@cf/some/other-model");
  });

  test("clamps steps into flux-1-schnell's 1-8 range", async () => {
    let capturedBody: { steps: number } | undefined;
    global.fetch = (async (_url: unknown, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ result: { image: "x" }, success: true, errors: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    const client = new CloudflareImageClient("acct-1", "cf-token");

    await client.generateImage("sunset", { steps: 100 });
    expect(capturedBody?.steps).toBe(8);

    await client.generateImage("sunset", { steps: -5 });
    expect(capturedBody?.steps).toBe(4);

    await client.generateImage("sunset", { steps: 2 });
    expect(capturedBody?.steps).toBe(2);
  });

  test("includes a seed when given, for reproducibility", async () => {
    let capturedBody: { seed?: number } | undefined;
    global.fetch = (async (_url: unknown, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ result: { image: "x" }, success: true, errors: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    const client = new CloudflareImageClient("acct-1", "cf-token");
    await client.generateImage("sunset", { seed: 42 });

    expect(capturedBody?.seed).toBe(42);
  });

  test("throws with the response detail on a non-ok HTTP response", async () => {
    global.fetch = (async () => new Response("rate limited", { status: 429 })) as unknown as typeof fetch;

    const client = new CloudflareImageClient("acct-1", "cf-token");
    await expect(client.generateImage("sunset")).rejects.toThrow(/429/);
  });

  test("throws when the response reports success: false", async () => {
    global.fetch = (async () =>
      new Response(JSON.stringify({ success: false, errors: [{ code: 1001, message: "daily Neurons allocation exhausted" }] }), {
        status: 200,
      })) as unknown as typeof fetch;

    const client = new CloudflareImageClient("acct-1", "cf-token");
    await expect(client.generateImage("sunset")).rejects.toThrow(/daily Neurons allocation exhausted/);
  });

  test("throws when the response is ok but carries no image", async () => {
    global.fetch = (async () =>
      new Response(JSON.stringify({ success: true, result: {} }), { status: 200 })) as unknown as typeof fetch;

    const client = new CloudflareImageClient("acct-1", "cf-token");
    await expect(client.generateImage("sunset")).rejects.toThrow(/Cloudflare image generation failed/);
  });
});
