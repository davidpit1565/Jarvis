import { describe, test, expect, afterEach } from "bun:test";
import { CalendarTokenStore } from "@/calendar/CalendarTokenStore";
import { GoogleCalendarClient } from "@/calendar/GoogleCalendarClient";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

function makeClient(tokenStore = new CalendarTokenStore(":memory:")) {
  return {
    client: new GoogleCalendarClient("client-id", "client-secret", "https://example.com/calendar/oauth/callback", tokenStore),
    tokenStore,
  };
}

describe("GoogleCalendarClient.buildAuthUrl", () => {
  test("includes offline access, forced consent, and the given state", () => {
    const { client } = makeClient();
    const url = new URL(client.buildAuthUrl("csrf-token-123"));

    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe("client-id");
    expect(url.searchParams.get("redirect_uri")).toBe("https://example.com/calendar/oauth/callback");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("state")).toBe("csrf-token-123");
    expect(url.searchParams.get("scope")).toBe(
      "https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/gmail.readonly"
    );
  });
});

describe("GoogleCalendarClient.exchangeCodeForTokens", () => {
  test("saves the returned tokens", async () => {
    global.fetch = (async () =>
      new Response(JSON.stringify({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600 }), {
        status: 200,
      })) as unknown as typeof fetch;

    const { client, tokenStore } = makeClient();
    await client.exchangeCodeForTokens("auth-code");

    expect(tokenStore.get()?.refreshToken).toBe("refresh-1");
    expect(tokenStore.get()?.accessToken).toBe("access-1");
  });

  test("throws when Google doesn't return a refresh token", async () => {
    global.fetch = (async () =>
      new Response(JSON.stringify({ access_token: "access-1", expires_in: 3600 }), { status: 200 })) as unknown as typeof fetch;

    const { client, tokenStore } = makeClient();
    await expect(client.exchangeCodeForTokens("auth-code")).rejects.toThrow(/refresh token/i);
    expect(tokenStore.isLinked()).toBe(false);
  });

  test("throws on a non-2xx response", async () => {
    global.fetch = (async () => new Response("bad code", { status: 400 })) as unknown as typeof fetch;

    const { client } = makeClient();
    await expect(client.exchangeCodeForTokens("bad-code")).rejects.toThrow(/400/);
  });
});

describe("GoogleCalendarClient.listUpcomingEvents", () => {
  test("throws when no account is linked", async () => {
    const { client } = makeClient();
    await expect(client.listUpcomingEvents()).rejects.toThrow(/no google account linked/i);
  });

  test("uses the stored access token directly when it's still valid", async () => {
    const tokenStore = new CalendarTokenStore(":memory:");
    tokenStore.save({ refreshToken: "refresh-1", accessToken: "still-valid", accessTokenExpiresAt: Date.now() + 3_600_000 });

    let capturedAuthHeader: string | undefined;
    global.fetch = (async (url: string, init?: RequestInit) => {
      capturedAuthHeader = (init?.headers as Record<string, string>)?.Authorization;
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    const { client } = makeClient(tokenStore);
    await client.listUpcomingEvents();

    expect(capturedAuthHeader).toBe("Bearer still-valid");
  });

  test("refreshes an expired access token before listing events", async () => {
    const tokenStore = new CalendarTokenStore(":memory:");
    tokenStore.save({ refreshToken: "refresh-1", accessToken: "expired", accessTokenExpiresAt: Date.now() - 1000 });

    const calls: string[] = [];
    global.fetch = (async (url: string, init?: RequestInit) => {
      calls.push(url);
      if (url.includes("oauth2.googleapis.com")) {
        return new Response(JSON.stringify({ access_token: "refreshed-token", expires_in: 3600 }), { status: 200 });
      }
      expect((init?.headers as Record<string, string>)?.Authorization).toBe("Bearer refreshed-token");
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    const { client } = makeClient(tokenStore);
    await client.listUpcomingEvents();

    expect(calls[0]).toContain("oauth2.googleapis.com");
    expect(tokenStore.get()?.accessToken).toBe("refreshed-token");
  });

  test("maps Google event fields into CalendarEvent, including all-day events", async () => {
    const tokenStore = new CalendarTokenStore(":memory:");
    tokenStore.save({ refreshToken: "refresh-1", accessToken: "valid", accessTokenExpiresAt: Date.now() + 3_600_000 });

    global.fetch = (async () =>
      new Response(
        JSON.stringify({
          items: [
            { id: "ev1", summary: "Team sync", start: { dateTime: "2026-01-15T09:00:00Z" }, end: { dateTime: "2026-01-15T09:30:00Z" }, location: "Zoom" },
            { id: "ev2", start: { date: "2026-01-16" }, end: { date: "2026-01-17" } },
          ],
        }),
        { status: 200 }
      )) as unknown as typeof fetch;

    const { client } = makeClient(tokenStore);
    const events = await client.listUpcomingEvents();

    expect(events).toEqual([
      { id: "ev1", summary: "Team sync", start: "2026-01-15T09:00:00Z", end: "2026-01-15T09:30:00Z", location: "Zoom" },
      { id: "ev2", summary: "(no title)", start: "2026-01-16", end: "2026-01-17", location: null },
    ]);
  });
});

function makeLinkedTokenStore(): CalendarTokenStore {
  const tokenStore = new CalendarTokenStore(":memory:");
  tokenStore.save({ refreshToken: "r1", accessToken: "valid", accessTokenExpiresAt: Date.now() + 3_600_000 });
  return tokenStore;
}

describe("GoogleCalendarClient.createEvent", () => {
  test("posts the event and returns the created event, mapped", async () => {
    let capturedBody: string | undefined;
    global.fetch = (async (url: string, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return new Response(
        JSON.stringify({
          id: "new-event-1",
          summary: "Dentist",
          location: "Clinic",
          start: { dateTime: "2026-01-20T10:00:00Z" },
          end: { dateTime: "2026-01-20T10:30:00Z" },
        }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const { client } = makeClient(makeLinkedTokenStore());
    const event = await client.createEvent({
      summary: "Dentist",
      start: "2026-01-20T10:00:00Z",
      end: "2026-01-20T10:30:00Z",
      location: "Clinic",
    });

    expect(event).toEqual({
      id: "new-event-1",
      summary: "Dentist",
      start: "2026-01-20T10:00:00Z",
      end: "2026-01-20T10:30:00Z",
      location: "Clinic",
    });

    const body = JSON.parse(capturedBody!);
    expect(body.summary).toBe("Dentist");
    expect(body.start).toEqual({ dateTime: "2026-01-20T10:00:00Z" });
  });

  test("throws on a non-2xx response", async () => {
    global.fetch = (async () => new Response("bad request", { status: 400 })) as unknown as typeof fetch;

    const { client } = makeClient(makeLinkedTokenStore());
    await expect(
      client.createEvent({ summary: "Test", start: "2026-01-20T10:00:00Z", end: "2026-01-20T10:30:00Z" })
    ).rejects.toThrow(/400/);
  });
});

describe("GoogleCalendarClient.deleteEvent", () => {
  test("succeeds on a 204 response", async () => {
    global.fetch = (async () => new Response(null, { status: 204 })) as unknown as typeof fetch;

    const { client } = makeClient(makeLinkedTokenStore());
    await expect(client.deleteEvent("event-1")).resolves.toBeUndefined();
  });

  test("treats a 410 (already gone) as success, not a failure", async () => {
    global.fetch = (async () => new Response("gone", { status: 410 })) as unknown as typeof fetch;

    const { client } = makeClient(makeLinkedTokenStore());
    await expect(client.deleteEvent("event-1")).resolves.toBeUndefined();
  });

  test("throws on another non-2xx response", async () => {
    global.fetch = (async () => new Response("forbidden", { status: 403 })) as unknown as typeof fetch;

    const { client } = makeClient(makeLinkedTokenStore());
    await expect(client.deleteEvent("event-1")).rejects.toThrow(/403/);
  });
});
