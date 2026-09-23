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

function makeLinkedTokenStore(email = "me@example.com"): CalendarTokenStore {
  const tokenStore = new CalendarTokenStore(":memory:");
  tokenStore.save(email, { refreshToken: "r1", accessToken: "valid", accessTokenExpiresAt: Date.now() + 3_600_000 });
  return tokenStore;
}

describe("GmailClient.searchMessages", () => {
  test("throws when no account is linked", async () => {
    const { client } = makeClient();
    await expect(client.searchMessages("from:x")).rejects.toThrow(/no google account linked/i);
  });

  test("refreshes an expired access token before searching", async () => {
    const tokenStore = new CalendarTokenStore(":memory:");
    tokenStore.save("me@example.com", { refreshToken: "refresh-1", accessToken: "expired", accessTokenExpiresAt: Date.now() - 1000 });

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
    expect(tokenStore.get("me@example.com")?.accessToken).toBe("refreshed-token");
  });

  test("fetches metadata for each matching message and maps it into EmailSummary, tagged with the account", async () => {
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
      { id: "m1", subject: "Checking in", from: "alice@example.com", date: "Mon, 1 Jan 2026 10:00:00 +0000", snippet: "Hey, just checking in...", account: "me@example.com" },
      { id: "m2", subject: "(no subject)", from: "", date: "", snippet: "No subject here", account: "me@example.com" },
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

  test("aggregates results across every linked account, merged newest-first and capped, each tagged with its own account", async () => {
    const tokenStore = new CalendarTokenStore(":memory:");
    tokenStore.save("work@example.com", { refreshToken: "r1", accessToken: "work-token", accessTokenExpiresAt: Date.now() + 3_600_000 });
    tokenStore.save("personal@example.com", { refreshToken: "r2", accessToken: "personal-token", accessTokenExpiresAt: Date.now() + 3_600_000 });

    global.fetch = (async (url: string, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string>)?.Authorization;
      const isWork = auth === "Bearer work-token";
      if (url.includes("/messages?")) {
        return new Response(JSON.stringify({ messages: [{ id: isWork ? "w1" : "p1" }] }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          id: isWork ? "w1" : "p1",
          snippet: "hi",
          payload: {
            headers: [
              { name: "Subject", value: isWork ? "Work thing" : "Personal thing" },
              { name: "From", value: "someone@example.com" },
              { name: "Date", value: isWork ? "Mon, 1 Jan 2026 09:00:00 +0000" : "Mon, 1 Jan 2026 10:00:00 +0000" },
            ],
          },
        }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const { client } = makeClient(tokenStore);
    const messages = await client.searchMessages("is:unread");

    expect(messages.map((m) => m.id)).toEqual(["p1", "w1"]); // 10:00 (personal) newer than 09:00 (work)
    expect(messages.find((m) => m.id === "p1")?.account).toBe("personal@example.com");
    expect(messages.find((m) => m.id === "w1")?.account).toBe("work@example.com");
  });

  test("a single explicit account is scoped to just that account", async () => {
    const tokenStore = new CalendarTokenStore(":memory:");
    tokenStore.save("work@example.com", { refreshToken: "r1", accessToken: "work-token", accessTokenExpiresAt: Date.now() + 3_600_000 });
    tokenStore.save("personal@example.com", { refreshToken: "r2", accessToken: "personal-token", accessTokenExpiresAt: Date.now() + 3_600_000 });

    const capturedAuths: string[] = [];
    global.fetch = (async (_url: string, init?: RequestInit) => {
      capturedAuths.push((init?.headers as Record<string, string>)?.Authorization ?? "");
      return new Response(JSON.stringify({ messages: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    const { client } = makeClient(tokenStore);
    await client.searchMessages("is:unread", 5, "work@example.com");

    expect(capturedAuths).toEqual(["Bearer work-token"]);
  });
});

describe("GmailClient.getMessageBody", () => {
  test("throws when no account is linked", async () => {
    const { client } = makeClient();
    await expect(client.getMessageBody("m1")).rejects.toThrow(/no google account linked/i);
  });

  test("decodes a text/plain body directly on the payload, tagged with the account", async () => {
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
      account: "me@example.com",
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

  test("finds a text/plain part nested behind an earlier text/html leaf sibling, instead of returning that leaf's raw HTML", async () => {
    // Real-world MIME shape: multipart/mixed[ text/html-only leaf,
    // multipart/alternative[ text/html, text/plain ] ] — the text/plain
    // part exists, but only inside the SECOND top-level part, after an
    // earlier sibling that's a bare text/html leaf with no nested parts.
    const plainText = "the real plain-text body";
    global.fetch = (async () =>
      new Response(
        JSON.stringify({
          payload: {
            mimeType: "multipart/mixed",
            headers: [{ name: "Subject", value: "Nested" }],
            parts: [
              { mimeType: "text/html", body: { data: Buffer.from("<p>banner</p>", "utf8").toString("base64url") } },
              {
                mimeType: "multipart/alternative",
                parts: [
                  { mimeType: "text/html", body: { data: Buffer.from("<p>html version</p>", "utf8").toString("base64url") } },
                  { mimeType: "text/plain", body: { data: Buffer.from(plainText, "utf8").toString("base64url") } },
                ],
              },
            ],
          },
        }),
        { status: 200 }
      )) as unknown as typeof fetch;

    const { client } = makeClient(makeLinkedTokenStore());
    const message = await client.getMessageBody("m1");

    expect(message.body).toBe(plainText);
  });

  test("falls back to raw HTML only when no text/plain part exists anywhere in the payload", async () => {
    const htmlBody = "<p>html only, no plain-text part exists</p>";
    global.fetch = (async () =>
      new Response(
        JSON.stringify({
          payload: {
            mimeType: "multipart/mixed",
            headers: [{ name: "Subject", value: "HTML only" }],
            parts: [{ mimeType: "text/html", body: { data: Buffer.from(htmlBody, "utf8").toString("base64url") } }],
          },
        }),
        { status: 200 }
      )) as unknown as typeof fetch;

    const { client } = makeClient(makeLinkedTokenStore());
    const message = await client.getMessageBody("m1");

    expect(message.body).toBe(htmlBody);
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

  test("with more than one linked account and no explicit account, probes each and finds it wherever it actually is", async () => {
    const tokenStore = new CalendarTokenStore(":memory:");
    tokenStore.save("work@example.com", { refreshToken: "r1", accessToken: "work-token", accessTokenExpiresAt: Date.now() + 3_600_000 });
    tokenStore.save("personal@example.com", { refreshToken: "r2", accessToken: "personal-token", accessTokenExpiresAt: Date.now() + 3_600_000 });

    global.fetch = (async (_url: string, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string>)?.Authorization;
      if (auth === "Bearer work-token") return new Response("not found", { status: 404 });
      return new Response(
        JSON.stringify({ payload: { mimeType: "text/plain", body: { data: Buffer.from("hi", "utf8").toString("base64url") }, headers: [] } }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const { client } = makeClient(tokenStore);
    const message = await client.getMessageBody("p1");

    expect(message.account).toBe("personal@example.com");
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

  test("retries a transient 429 and succeeds once Gmail's rate limit clears", async () => {
    let fetchCalls = 0;
    global.fetch = (async () => {
      fetchCalls++;
      if (fetchCalls < 2) return new Response("rate limited", { status: 429 });
      return new Response(JSON.stringify({ resultSizeEstimate: 3 }), { status: 200 });
    }) as unknown as typeof fetch;

    const { client } = makeClient(makeLinkedTokenStore());
    const count = await client.getMessageCount("is:unread");

    expect(count).toBe(3);
    expect(fetchCalls).toBe(2);
  });

  test("sums the count across every linked account", async () => {
    const tokenStore = new CalendarTokenStore(":memory:");
    tokenStore.save("work@example.com", { refreshToken: "r1", accessToken: "work-token", accessTokenExpiresAt: Date.now() + 3_600_000 });
    tokenStore.save("personal@example.com", { refreshToken: "r2", accessToken: "personal-token", accessTokenExpiresAt: Date.now() + 3_600_000 });

    global.fetch = (async (_url: string, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string>)?.Authorization;
      const n = auth === "Bearer work-token" ? 4 : 9;
      return new Response(JSON.stringify({ resultSizeEstimate: n }), { status: 200 });
    }) as unknown as typeof fetch;

    const { client } = makeClient(tokenStore);
    expect(await client.getMessageCount("is:unread")).toBe(13);
  });
});

describe("GmailClient.sendMessage rate handling", () => {
  test("retries a 429 (Gmail rejected the send outright, safe to retry) and succeeds", async () => {
    let fetchCalls = 0;
    global.fetch = (async () => {
      fetchCalls++;
      if (fetchCalls < 2) return new Response("rate limited", { status: 429 });
      return new Response(JSON.stringify({ id: "sent-1" }), { status: 200 });
    }) as unknown as typeof fetch;

    const { client } = makeClient(makeLinkedTokenStore());
    const result = await client.sendMessage("to@example.com", "Subject", "Body");

    expect(result).toEqual({ id: "sent-1", account: "me@example.com" });
    expect(fetchCalls).toBe(2);
  });

  test("does not retry a network-level failure on send (ambiguous whether Gmail already received it)", async () => {
    let fetchCalls = 0;
    global.fetch = (async () => {
      fetchCalls++;
      throw new Error("connection reset");
    }) as unknown as typeof fetch;

    const { client } = makeClient(makeLinkedTokenStore());
    await expect(client.sendMessage("to@example.com", "Subject", "Body")).rejects.toThrow("connection reset");
    expect(fetchCalls).toBe(1);
  });
});

describe("GmailClient.sendMessage account targeting", () => {
  test("sends from the primary (first-linked) account when none is given", async () => {
    const tokenStore = new CalendarTokenStore(":memory:");
    tokenStore.save("work@example.com", { refreshToken: "r1", accessToken: "work-token", accessTokenExpiresAt: Date.now() + 3_600_000 });
    tokenStore.save("personal@example.com", { refreshToken: "r2", accessToken: "personal-token", accessTokenExpiresAt: Date.now() + 3_600_000 });

    let capturedAuth: string | undefined;
    global.fetch = (async (_url: string, init?: RequestInit) => {
      capturedAuth = (init?.headers as Record<string, string>)?.Authorization;
      return new Response(JSON.stringify({ id: "sent-1" }), { status: 200 });
    }) as unknown as typeof fetch;

    const { client } = makeClient(tokenStore);
    const result = await client.sendMessage("to@example.com", "Subject", "Body");

    expect(capturedAuth).toBe("Bearer work-token");
    expect(result.account).toBe("work@example.com");
  });

  test("sends from the explicitly given account instead of the primary", async () => {
    const tokenStore = new CalendarTokenStore(":memory:");
    tokenStore.save("work@example.com", { refreshToken: "r1", accessToken: "work-token", accessTokenExpiresAt: Date.now() + 3_600_000 });
    tokenStore.save("personal@example.com", { refreshToken: "r2", accessToken: "personal-token", accessTokenExpiresAt: Date.now() + 3_600_000 });

    let capturedAuth: string | undefined;
    global.fetch = (async (_url: string, init?: RequestInit) => {
      capturedAuth = (init?.headers as Record<string, string>)?.Authorization;
      return new Response(JSON.stringify({ id: "sent-2" }), { status: 200 });
    }) as unknown as typeof fetch;

    const { client } = makeClient(tokenStore);
    const result = await client.sendMessage("to@example.com", "Subject", "Body", "personal@example.com");

    expect(capturedAuth).toBe("Bearer personal-token");
    expect(result.account).toBe("personal@example.com");
  });

  test("throws a clear error when the explicit account isn't linked", async () => {
    const { client } = makeClient(makeLinkedTokenStore());
    await expect(client.sendMessage("to@example.com", "Subject", "Body", "nobody@example.com")).rejects.toThrow(/nobody@example\.com/);
  });
});

describe("GmailClient non-ASCII header encoding", () => {
  function decodeRawMessage(raw: string): string {
    const base64 = raw.replace(/-/g, "+").replace(/_/g, "/");
    return Buffer.from(base64, "base64").toString("utf8");
  }

  test("RFC 2047-encodes a non-ASCII subject instead of embedding raw UTF-8 bytes", async () => {
    let capturedRaw = "";
    global.fetch = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? "{}");
      capturedRaw = body.raw;
      return new Response(JSON.stringify({ id: "sent-1" }), { status: 200 });
    }) as unknown as typeof fetch;

    const { client } = makeClient(makeLinkedTokenStore());
    await client.sendMessage("to@example.com", "Café risotto — 明日の会議", "Body");

    const message = decodeRawMessage(capturedRaw);
    const subjectLine = message.split("\r\n").find((line) => line.startsWith("Subject:"));
    expect(subjectLine).not.toContain("Café");
    expect(subjectLine).toMatch(/^Subject: =\?UTF-8\?B\?.+\?=$/);

    const encoded = subjectLine!.replace("Subject: ", "");
    const base64Payload = encoded.match(/^=\?UTF-8\?B\?(.+)\?=$/)![1] ?? "";
    expect(Buffer.from(base64Payload, "base64").toString("utf8")).toBe("Café risotto — 明日の会議");
  });

  test("leaves an ASCII subject untouched", async () => {
    let capturedRaw = "";
    global.fetch = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? "{}");
      capturedRaw = body.raw;
      return new Response(JSON.stringify({ id: "sent-1" }), { status: 200 });
    }) as unknown as typeof fetch;

    const { client } = makeClient(makeLinkedTokenStore());
    await client.sendMessage("to@example.com", "Plain subject", "Body");

    const message = decodeRawMessage(capturedRaw);
    expect(message).toContain("Subject: Plain subject");
  });

  test("RFC 2047-encodes only the display name of a non-ASCII 'To' address, leaving the address itself literal", async () => {
    let capturedRaw = "";
    global.fetch = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? "{}");
      capturedRaw = body.raw;
      return new Response(JSON.stringify({ id: "sent-1" }), { status: 200 });
    }) as unknown as typeof fetch;

    const { client } = makeClient(makeLinkedTokenStore());
    await client.sendMessage('"José García" <jose@example.com>', "Subject", "Body");

    const message = decodeRawMessage(capturedRaw);
    const toLine = message.split("\r\n").find((line) => line.startsWith("To:"))!;
    expect(toLine).toContain("<jose@example.com>");
    expect(toLine).not.toContain("José");
    expect(toLine).toMatch(/^To: =\?UTF-8\?B\?.+\?= <jose@example\.com>$/);
  });

  test("declares Content-Transfer-Encoding: 8bit so a non-ASCII body isn't sent under the implied 7bit default", async () => {
    let capturedRaw = "";
    global.fetch = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? "{}");
      capturedRaw = body.raw;
      return new Response(JSON.stringify({ id: "sent-1" }), { status: 200 });
    }) as unknown as typeof fetch;

    const { client } = makeClient(makeLinkedTokenStore());
    await client.sendMessage("to@example.com", "Subject", "Café meeting at 3pm — see you there 🎉");

    const message = decodeRawMessage(capturedRaw);
    expect(message).toContain("Content-Transfer-Encoding: 8bit");
    expect(message).toContain("Café meeting at 3pm — see you there 🎉");
  });
});
