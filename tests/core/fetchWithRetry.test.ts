import { describe, test, expect, afterEach } from "bun:test";
import { fetchWithRetry, isRetryableStatus } from "@/core/net/fetchWithRetry";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

const noopSleep = async () => {};

describe("isRetryableStatus", () => {
  test("429 and every 5xx are retryable", () => {
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(599)).toBe(true);
  });

  test("2xx and other 4xx are not retryable", () => {
    expect(isRetryableStatus(200)).toBe(false);
    expect(isRetryableStatus(400)).toBe(false);
    expect(isRetryableStatus(404)).toBe(false);
  });
});

describe("fetchWithRetry", () => {
  test("returns immediately on a successful response", async () => {
    let calls = 0;
    global.fetch = (async () => {
      calls++;
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;

    const response = await fetchWithRetry("https://example.com", {}, { sleep: noopSleep });

    expect(response.status).toBe(200);
    expect(calls).toBe(1);
  });

  test("returns a non-retryable 4xx immediately, without retrying", async () => {
    let calls = 0;
    global.fetch = (async () => {
      calls++;
      return new Response("bad", { status: 400 });
    }) as unknown as typeof fetch;

    const response = await fetchWithRetry("https://example.com", {}, { sleep: noopSleep });

    expect(response.status).toBe(400);
    expect(calls).toBe(1);
  });

  test("retries on a 429 and succeeds on a later attempt", async () => {
    let calls = 0;
    global.fetch = (async () => {
      calls++;
      if (calls < 3) return new Response("rate limited", { status: 429 });
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;

    const response = await fetchWithRetry("https://example.com", {}, { maxAttempts: 3, sleep: noopSleep });

    expect(response.status).toBe(200);
    expect(calls).toBe(3);
  });

  test("gives up and returns the last response after maxAttempts retryable failures", async () => {
    let calls = 0;
    global.fetch = (async () => {
      calls++;
      return new Response("still failing", { status: 503 });
    }) as unknown as typeof fetch;

    const response = await fetchWithRetry("https://example.com", {}, { maxAttempts: 3, sleep: noopSleep });

    expect(response.status).toBe(503);
    expect(calls).toBe(3);
  });

  test("retries a network-level failure (e.g. connection reset) and eventually throws if it never recovers", async () => {
    let calls = 0;
    global.fetch = (async () => {
      calls++;
      throw new Error("connection reset");
    }) as unknown as typeof fetch;

    await expect(fetchWithRetry("https://example.com", {}, { maxAttempts: 2, sleep: noopSleep })).rejects.toThrow(
      "connection reset"
    );
    expect(calls).toBe(2);
  });

  test("waits with exponential backoff between retries", async () => {
    let calls = 0;
    global.fetch = (async () => {
      calls++;
      return new Response("rate limited", { status: 429 });
    }) as unknown as typeof fetch;

    const delays: number[] = [];
    await fetchWithRetry(
      "https://example.com",
      {},
      {
        maxAttempts: 3,
        baseDelayMs: 100,
        sleep: async (ms) => {
          delays.push(ms);
        },
      }
    );

    expect(delays).toEqual([100, 200]);
    expect(calls).toBe(3);
  });
});
