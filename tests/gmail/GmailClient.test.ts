import { describe, test, expect, afterEach } from "bun:test";
import { CalendarTokenStore } from "@/calendar/CalendarTokenStore";
import { GmailClient } from "@/gmail/GmailClient";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

function makeClient(tokenStore = new CalendarTokenStore(":memory:")) {
  return { client: new GmailClient("client-id", "client-secret", tokenStore), tokenStore };
}

function makeLinkedTokenStore(): CalendarTokenStore {
  const tokenStore = new CalendarTokenStore(":memory:");
  tokenStore.save({ refreshToken: "r1", accessToken: "valid", accessTokenExpiresAt: Date.now() + 3_600_000 });
  return tokenStore;
}

describe("GmailClient.searchMessages", () => {
  test("throws when no account is linked", async () => {
    const { client } = makeClient();
    await expect(client.searchMessages("from:x")).rejects.toThrow(/no google account linked/i);
  });

  test("refreshes an expired access token before searching", async () => {
    const tokenStore = new CalendarTokenStore(":memory:");
    tokenStore.save({ refreshToken: "refresh-1", accessToken: "expired", accessTokenExpiresAt: Date.now() - 1000 });

    const calls: string[] = [];
    global.fetch = (async (url: string, init?: RequestInit) => {
      calls.push(url);
      if (url.includes("oauth2.googleapis.com")) {
        return new Response(JSON.stringify({ access_token: "refreshed-token", expires_in: 3600 }), { status: 200 });
      }
      expect((init?.headers as Record<string, string>)?.Authorization).toBe("Bearer refreshed-token");
      return new Response(JSON.stringify({ messages: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    const { client } = makeClient(tokenStore);
    await client.searchMessages("from:x");

    expect(calls[0]).toContain("oauth2.googleapis.com");
    expect(tokenStore.get()?.accessToken).toBe("refreshed-token");
  });

  test("fetches metadata for each matching message and maps it into EmailSummary", async () => {
    global.fetch = (async (url: string) => {
      if (url.includes("/messages?")) {
        return new Response(JSON.stringify({ messages: [{ id: "m1" }, { id: "m2" }] }), { status: 200 });
      }
      if (url.includes("/messages/m1")) {
        return new Response(
          JSON.stringify({
            id: "m1",
            snippet: "Hey, just checking in...",
            payload: {
              headers: [
                { name: "Subject", value: "Checking in" },
                { name: "From", value: "alice@example.com" },
                { name: "Date", value: "Mon, 1 Jan 2026 10:00:00 +0000" },
              ],
            },
          }),
          { status: 200 }
        );
      }
      return new Response(
        JSON.stringify({ id: "m2", snippet: "No subject here", payload: { headers: [] } }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const { client } = makeClient(makeLinkedTokenStore());
    const messages = await client.searchMessages("is:unread");

    expect(messages).toEqual([
      { id: "m1", subject: "Checking in", from: "alice@example.com", date: "Mon, 1 Jan 2026 10:00:00 +0000", snippet: "Hey, just checking in..." },
      { id: "m2", subject: "(no subject)", from: "", date: "", snippet: "No subject here" },
    ]);
  });

  test("caps maxResults at 10 even if a larger value is requested", async () => {
    let capturedMaxResults: string | null = null;
    global.fetch = (async (url: string) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith("/messages")) {
        capturedMaxResults = parsed.searchParams.get("maxResults");
        return new Response(JSON.stringify({ messages: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }) as unknown as typeof fetch;

    const { client } = makeClient(makeLinkedTokenStore());
    await client.searchMessages("is:unread", 50);

    expect(capturedMaxResults as unknown as string).toBe("10");
  });

  test("throws on a non-2xx search response", async () => {
    global.fetch = (async () => new Response("bad request", { status: 400 })) as unknown as typeof fetch;

    const { client } = makeClient(makeLinkedTokenStore());
    await expect(client.searchMessages("is:unread")).rejects.toThrow(/400/);
  });
});

describe("GmailClient.getMessageBody", () => {
  test("throws when no account is linked", async () => {
    const { client } = makeClient();
    await expect(client.getMessageBody("m1")).rejects.toThrow(/no google account linked/i);
  });

  test("decodes a text/plain body directly on the payload", async () => {
    const bodyText = "Hello, this is the email body.";
    global.fetch = (async () =>
      new Response(
        JSON.stringify({
          payload: {
            mimeType: "text/plain",
            body: { data: Buffer.from(bodyText, "utf8").toString("base64url") },
            headers: [
              { name: "Subject", value: "Hi" },
              { name: "From", value: "alice@example.com" },
              { name: "Date", value: "Mon, 1 Jan 2026 10:00:00 +0000" },
            ],
          },
        }),
        { status: 200 }
      )) as unknown as typeof fetch;

    const { client } = makeClient(makeLinkedTokenStore());
    const message = await client.getMessageBody("m1");

    expect(message).toEqual({
      subject: "Hi",
      from: "alice@example.com",
      date: "Mon, 1 Jan 2026 10:00:00 +0000",
      body: bodyText,
    });
  });

  test("prefers the text/plain part over text/html in a multipart message", async () => {
    const plainText = "plain body";
    global.fetch = (async () =>
      new Response(
        JSON.stringify({
          payload: {
            mimeType: "multipart/alternative",
            headers: [{ name: "Subject", value: "Multi" }],
            parts: [
              { mimeType: "text/html", body: { data: Buffer.from("<b>html body</b>", "utf8").toString("base64url") } },
              { mimeType: "text/plain", body: { data: Buffer.from(plainText, "utf8").toString("base64url") } },
            ],
          },
        }),
        { status: 200 }
      )) as unknown as typeof fetch;

    const { client } = makeClient(makeLinkedTokenStore());
    const message = await client.getMessageBody("m1");

    expect(message.body).toBe(plainText);
  });

  test("falls back to an empty body when nothing decodable is found", async () => {
    global.fetch = (async () =>
      new Response(JSON.stringify({ payload: { headers: [] } }), { status: 200 })) as unknown as typeof fetch;

    const { client } = makeClient(makeLinkedTokenStore());
    const message = await client.getMessageBody("m1");

    expect(message.body).toBe("");
    expect(message.subject).toBe("(no subject)");
  });

  test("throws on a non-2xx response", async () => {
    global.fetch = (async () => new Response("not found", { status: 404 })) as unknown as typeof fetch;

    const { client } = makeClient(makeLinkedTokenStore());
    await expect(client.getMessageBody("missing")).rejects.toThrow(/404/);
  });

  test("truncates a body longer than the cap, with a trailer noting how much was cut", async () => {
    const longBody = "x".repeat(5000);
    global.fetch = (async () =>
      new Response(
        JSON.stringify({
          payload: {
            mimeType: "text/plain",
            body: { data: Buffer.from(longBody, "utf8").toString("base64url") },
            headers: [{ name: "Subject", value: "Long" }],
          },
        }),
        { status: 200 }
      )) as unknown as typeof fetch;

    const { client } = makeClient(makeLinkedTokenStore());
    const message = await client.getMessageBody("m1");

    expect(message.body.startsWith("x".repeat(4000))).toBe(true);
    expect(message.body.length).toBeLessThan(longBody.length);
    expect(message.body).toContain("truncated, 1000 more characters");
  });

  test("does not truncate a body under the cap", async () => {
    const shortBody = "a normal length email body";
    global.fetch = (async () =>
      new Response(
        JSON.stringify({
          payload: {
            mimeType: "text/plain",
            body: { data: Buffer.from(shortBody, "utf8").toString("base64url") },
            headers: [{ name: "Subject", value: "Short" }],
          },
        }),
        { status: 200 }
      )) as unknown as typeof fetch;

    const { client } = makeClient(makeLinkedTokenStore());
    const message = await client.getMessageBody("m1");

    expect(message.body).toBe(shortBody);
  });
});

describe("GmailClient.getMessageCount", () => {
  test("throws when no account is linked", async () => {
    const { client } = makeClient();
    await expect(client.getMessageCount("is:unread")).rejects.toThrow(/no google account linked/i);
  });

  test("returns resultSizeEstimate without fetching per-message summaries", async () => {
    let fetchCalls = 0;
    global.fetch = (async (url: string) => {
      fetchCalls++;
      expect(new URL(url).searchParams.get("q")).toBe("is:unread");
      return new Response(JSON.stringify({ resultSizeEstimate: 7 }), { status: 200 });
    }) as unknown as typeof fetch;

    const { client } = makeClient(makeLinkedTokenStore());
    const count = await client.getMessageCount("is:unread");

    expect(count).toBe(7);
    expect(fetchCalls).toBe(1);
  });

  test("defaults to 0 when resultSizeEstimate is absent", async () => {
    global.fetch = (async () => new Response(JSON.stringify({}), { status: 200 })) as unknown as typeof fetch;

    const { client } = makeClient(makeLinkedTokenStore());
    expect(await client.getMessageCount("is:unread")).toBe(0);
  });

  test("throws on a non-2xx response", async () => {
    global.fetch = (async () => new Response("bad request", { status: 400 })) as unknown as typeof fetch;

    const { client } = makeClient(makeLinkedTokenStore());
    await expect(client.getMessageCount("is:unread")).rejects.toThrow(/400/);
  });
});
