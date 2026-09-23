import { describe, test, expect, afterEach } from "bun:test";
import { AgentMailClient } from "@/agentmail/AgentMailClient";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

function makeClient() {
  return new AgentMailClient("test-api-key", "jarvis-inbox");
}

describe("AgentMailClient.sendMessage", () => {
  test("posts to the send endpoint with a bearer auth header and the expected body shape", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    global.fetch = (async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return new Response(JSON.stringify({ message_id: "m1", thread_id: "t1" }), { status: 200 });
    }) as unknown as typeof fetch;

    const client = makeClient();
    const result = await client.sendMessage("bob@example.com", "Hi", "Hello there");

    expect(result).toEqual({ messageId: "m1", threadId: "t1" });
    expect(capturedUrl).toBe("https://api.agentmail.to/v0/inboxes/jarvis-inbox/messages/send");
    expect((capturedInit?.headers as Record<string, string>).Authorization).toBe("Bearer test-api-key");
    const body = JSON.parse(capturedInit?.body as string);
    expect(body).toEqual({ to: ["bob@example.com"], subject: "Hi", text: "Hello there" });
  });

  test("never leaks the API key in a failure message", async () => {
    global.fetch = (async () => new Response("forbidden", { status: 403 })) as unknown as typeof fetch;

    const client = makeClient();
    await expect(client.sendMessage("bob@example.com", "Hi", "Hello")).rejects.toThrow(
      /AgentMail send failed \(403\)/
    );
    try {
      await client.sendMessage("bob@example.com", "Hi", "Hello");
    } catch (error) {
      expect(String(error)).not.toContain("test-api-key");
    }
  });

  test("retries a transient 429 and succeeds once AgentMail's rate limit clears", async () => {
    let fetchCalls = 0;
    global.fetch = (async () => {
      fetchCalls++;
      if (fetchCalls < 2) return new Response("rate limited", { status: 429 });
      return new Response(JSON.stringify({ message_id: "m2", thread_id: "t2" }), { status: 200 });
    }) as unknown as typeof fetch;

    const client = makeClient();
    const result = await client.sendMessage("bob@example.com", "Hi", "Hello");

    expect(result).toEqual({ messageId: "m2", threadId: "t2" });
    expect(fetchCalls).toBe(2);
  });

  test("does not retry a network-level failure on send (ambiguous whether AgentMail already received it)", async () => {
    let fetchCalls = 0;
    global.fetch = (async () => {
      fetchCalls++;
      throw new Error("connection reset");
    }) as unknown as typeof fetch;

    const client = makeClient();
    await expect(client.sendMessage("bob@example.com", "Hi", "Hello")).rejects.toThrow("connection reset");
    expect(fetchCalls).toBe(1);
  });

  test("returns a clear auth error on a 401, without a raw body dump", async () => {
    global.fetch = (async () => new Response("", { status: 401 })) as unknown as typeof fetch;

    const client = makeClient();
    await expect(client.sendMessage("bob@example.com", "Hi", "Hello")).rejects.toThrow(/rejected the configured API key/);
  });
});

describe("AgentMailClient.listMessages", () => {
  test("fetches from the messages list endpoint and maps fields", async () => {
    let capturedUrl = "";
    global.fetch = (async (url: string) => {
      capturedUrl = url;
      return new Response(
        JSON.stringify({
          messages: [
            {
              message_id: "m1",
              thread_id: "t1",
              from: "alice@example.com",
              to: ["jarvis@agentmail.to"],
              subject: "Hello",
              preview: "hi there",
              timestamp: "2026-01-01T00:00:00Z",
            },
          ],
        }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const client = makeClient();
    const messages = await client.listMessages();

    expect(new URL(capturedUrl).pathname).toBe("/v0/inboxes/jarvis-inbox/messages");
    expect(messages).toEqual([
      {
        messageId: "m1",
        threadId: "t1",
        from: "alice@example.com",
        to: ["jarvis@agentmail.to"],
        subject: "Hello",
        preview: "hi there",
        timestamp: "2026-01-01T00:00:00Z",
      },
    ]);
  });

  test("caps maxResults at the hard limit even if a larger value is requested", async () => {
    const capturedLimits: Array<string | null> = [];
    global.fetch = (async (url: string) => {
      capturedLimits.push(new URL(url).searchParams.get("limit"));
      return new Response(JSON.stringify({ messages: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    const client = makeClient();
    await client.listMessages(500);

    expect(capturedLimits[0]).toBe("20");
  });

  test("defaults to an empty list when the API returns no messages field", async () => {
    global.fetch = (async () => new Response(JSON.stringify({}), { status: 200 })) as unknown as typeof fetch;

    const client = makeClient();
    expect(await client.listMessages()).toEqual([]);
  });

  test("throws on a non-2xx response", async () => {
    global.fetch = (async () => new Response("bad request", { status: 400 })) as unknown as typeof fetch;

    const client = makeClient();
    await expect(client.listMessages()).rejects.toThrow(/400/);
  });

  test("does not leak the raw response body into the thrown error", async () => {
    global.fetch = (async () =>
      new Response(JSON.stringify({ error: "internal upstream detail" }), { status: 400 })) as unknown as typeof fetch;

    const client = makeClient();
    let error: Error | undefined;
    await client.listMessages().catch((e) => {
      error = e as Error;
    });
    expect(error?.message).not.toContain("internal upstream detail");
    expect(error?.message).toContain("400");
  });
});

describe("AgentMailClient.getMessage", () => {
  test("fetches a single message by id and truncates a long body", async () => {
    const longText = "x".repeat(5000);
    global.fetch = (async () =>
      new Response(
        JSON.stringify({
          message_id: "m1",
          thread_id: "t1",
          from: "alice@example.com",
          to: ["jarvis@agentmail.to"],
          subject: "Long one",
          preview: "preview",
          timestamp: "2026-01-01T00:00:00Z",
          text: longText,
        }),
        { status: 200 }
      )) as unknown as typeof fetch;

    const client = makeClient();
    const message = await client.getMessage("m1");

    expect(message.text.startsWith("x".repeat(4000))).toBe(true);
    expect(message.text).toContain("truncated, 1000 more characters");
  });

  test("throws on a non-2xx response", async () => {
    global.fetch = (async () => new Response("not found", { status: 404 })) as unknown as typeof fetch;

    const client = makeClient();
    await expect(client.getMessage("missing")).rejects.toThrow(/404/);
  });
});
