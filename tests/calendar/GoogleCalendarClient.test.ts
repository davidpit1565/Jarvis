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

function makeLinkedTokenStore(email = "me@example.com"): CalendarTokenStore {
  const tokenStore = new CalendarTokenStore(":memory:");
  tokenStore.save(email, { refreshToken: "r1", accessToken: "valid", accessTokenExpiresAt: Date.now() + 3_600_000 });
  return tokenStore;
}

/** Routes a mocked fetch by URL: oauth2 token endpoint, userinfo endpoint, or (by default) the Calendar API. */
function routedFetch(handlers: { userinfo?: (url: string) => Response; calendar?: (url: string, init?: RequestInit) => Response }) {
  return (async (url: string, init?: RequestInit) => {
    if (url.includes("oauth2.googleapis.com")) {
      return new Response(JSON.stringify({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600 }), { status: 200 });
    }
    if (url.includes("userinfo")) {
      return handlers.userinfo ? handlers.userinfo(url) : new Response(JSON.stringify({ email: "me@example.com" }), { status: 200 });
    }
    return handlers.calendar
      ? handlers.calendar(url, init)
      : new Response(JSON.stringify({ items: [] }), { status: 200 });
  }) as unknown as typeof fetch;
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
      "https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/gmail.readonly " +
        "https://www.googleapis.com/auth/gmail.send"
    );
  });
});

describe("GoogleCalendarClient.exchangeCodeForTokens", () => {
  test("identifies the account via userinfo and saves the tokens keyed by its email", async () => {
    global.fetch = routedFetch({ userinfo: () => new Response(JSON.stringify({ email: "alice@example.com" }), { status: 200 }) });

    const { client, tokenStore } = makeClient();
    const email = await client.exchangeCodeForTokens("auth-code");

    expect(email).toBe("alice@example.com");
    expect(tokenStore.get("alice@example.com")?.refreshToken).toBe("refresh-1");
    expect(tokenStore.get("alice@example.com")?.accessToken).toBe("access-1");
  });

  test("linking a SECOND account is additive — the first account's tokens are untouched", async () => {
    const { client, tokenStore } = makeClient();

    global.fetch = routedFetch({ userinfo: () => new Response(JSON.stringify({ email: "work@example.com" }), { status: 200 }) });
    await client.exchangeCodeForTokens("code-1");

    global.fetch = routedFetch({ userinfo: () => new Response(JSON.stringify({ email: "personal@example.com" }), { status: 200 }) });
    await client.exchangeCodeForTokens("code-2");

    expect(tokenStore.isLinked("work@example.com")).toBe(true);
    expect(tokenStore.isLinked("personal@example.com")).toBe(true);
    expect(tokenStore.getAll()).toHaveLength(2);
  });

  test("re-linking the SAME account updates it in place, not as a duplicate", async () => {
    const { client, tokenStore } = makeClient();
    global.fetch = routedFetch({ userinfo: () => new Response(JSON.stringify({ email: "me@example.com" }), { status: 200 }) });

    await client.exchangeCodeForTokens("code-1");
    await client.exchangeCodeForTokens("code-2");

    expect(tokenStore.getAll()).toHaveLength(1);
  });

  test("throws when Google doesn't return a refresh token", async () => {
    global.fetch = (async () =>
      new Response(JSON.stringify({ access_token: "access-1", expires_in: 3600 }), { status: 200 })) as unknown as typeof fetch;

    const { client, tokenStore } = makeClient();
    await expect(client.exchangeCodeForTokens("auth-code")).rejects.toThrow(/refresh token/i);
    expect(tokenStore.getAll()).toEqual([]);
  });

  test("throws on a non-2xx response from the token endpoint", async () => {
    global.fetch = (async () => new Response("bad code", { status: 400 })) as unknown as typeof fetch;

    const { client } = makeClient();
    await expect(client.exchangeCodeForTokens("bad-code")).rejects.toThrow(/400/);
  });

  test("throws when the userinfo endpoint doesn't return an email", async () => {
    global.fetch = routedFetch({ userinfo: () => new Response(JSON.stringify({}), { status: 200 }) });

    const { client } = makeClient();
    await expect(client.exchangeCodeForTokens("auth-code")).rejects.toThrow(/email/i);
  });
});

describe("GoogleCalendarClient.backfillLegacyAccountEmails", () => {
  test("re-keys a legacy-linked row onto its real, fetched email", async () => {
    const tokenStore = new CalendarTokenStore(":memory:");
    tokenStore.save("google", { refreshToken: "legacy-refresh", accessToken: "legacy-access", accessTokenExpiresAt: Date.now() + 3_600_000 });

    global.fetch = routedFetch({ userinfo: () => new Response(JSON.stringify({ email: "real@example.com" }), { status: 200 }) });

    const { client } = makeClient(tokenStore);
    await client.backfillLegacyAccountEmails();

    expect(tokenStore.isLinked("google")).toBe(false);
    expect(tokenStore.isLinked("real@example.com")).toBe(true);
  });

  test("is a no-op when there's nothing to backfill", async () => {
    const tokenStore = makeLinkedTokenStore("already-real@example.com");
    const { client } = makeClient(tokenStore);

    await expect(client.backfillLegacyAccountEmails()).resolves.toBeUndefined();
    expect(tokenStore.isLinked("already-real@example.com")).toBe(true);
  });

  test("swallows its own errors instead of throwing, on a userinfo failure", async () => {
    const tokenStore = new CalendarTokenStore(":memory:");
    tokenStore.save("google", { refreshToken: "legacy-refresh", accessToken: "legacy-access", accessTokenExpiresAt: Date.now() + 3_600_000 });
    global.fetch = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;

    const { client } = makeClient(tokenStore);
    await expect(client.backfillLegacyAccountEmails()).resolves.toBeUndefined();
    // Stays linked under the placeholder key — still usable, just not backfilled yet.
    expect(tokenStore.isLinked("google")).toBe(true);
  });
});

describe("GoogleCalendarClient.listUpcomingEvents", () => {
  test("throws when no account is linked", async () => {
    const { client } = makeClient();
    await expect(client.listUpcomingEvents()).rejects.toThrow(/no google account linked/i);
  });

  test("uses the stored access token directly when it's still valid", async () => {
    const tokenStore = new CalendarTokenStore(":memory:");
    tokenStore.save("me@example.com", { refreshToken: "refresh-1", accessToken: "still-valid", accessTokenExpiresAt: Date.now() + 3_600_000 });

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
    tokenStore.save("me@example.com", { refreshToken: "refresh-1", accessToken: "expired", accessTokenExpiresAt: Date.now() - 1000 });

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
    expect(tokenStore.get("me@example.com")?.accessToken).toBe("refreshed-token");
  });

  test("maps Google event fields into CalendarEvent, tagged with the linked account, including all-day events", async () => {
    const tokenStore = new CalendarTokenStore(":memory:");
    tokenStore.save("me@example.com", { refreshToken: "refresh-1", accessToken: "valid", accessTokenExpiresAt: Date.now() + 3_600_000 });

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
      { id: "ev1", summary: "Team sync", start: "2026-01-15T09:00:00Z", end: "2026-01-15T09:30:00Z", location: "Zoom", account: "me@example.com" },
      { id: "ev2", summary: "(no title)", start: "2026-01-16", end: "2026-01-17", location: null, account: "me@example.com" },
    ]);
  });

  test("caps maxResults at 50 even if a larger value is requested", async () => {
    let capturedMaxResults: string | null = null;
    global.fetch = (async (url: string) => {
      capturedMaxResults = new URL(url).searchParams.get("maxResults");
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    const { client } = makeClient(makeLinkedTokenStore());
    await client.listUpcomingEvents(500);

    expect(capturedMaxResults as unknown as string).toBe("50");
  });

  test("aggregates events across every linked account, merged and sorted soonest-first, tagged with their own account", async () => {
    const tokenStore = new CalendarTokenStore(":memory:");
    tokenStore.save("work@example.com", { refreshToken: "r1", accessToken: "work-token", accessTokenExpiresAt: Date.now() + 3_600_000 });
    tokenStore.save("personal@example.com", { refreshToken: "r2", accessToken: "personal-token", accessTokenExpiresAt: Date.now() + 3_600_000 });

    global.fetch = (async (_url: string, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string>)?.Authorization;
      if (auth === "Bearer work-token") {
        return new Response(
          JSON.stringify({ items: [{ id: "w1", summary: "Standup", start: { dateTime: "2026-01-15T09:00:00Z" }, end: { dateTime: "2026-01-15T09:15:00Z" } }] }),
          { status: 200 }
        );
      }
      return new Response(
        JSON.stringify({ items: [{ id: "p1", summary: "Dentist", start: { dateTime: "2026-01-15T08:00:00Z" }, end: { dateTime: "2026-01-15T08:30:00Z" } }] }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const { client } = makeClient(tokenStore);
    const events = await client.listUpcomingEvents();

    expect(events.map((e) => e.id)).toEqual(["p1", "w1"]); // 08:00 dentist (personal) before 09:00 standup (work)
    expect(events.find((e) => e.id === "p1")?.account).toBe("personal@example.com");
    expect(events.find((e) => e.id === "w1")?.account).toBe("work@example.com");
  });

  test("a single explicit account is scoped to just that account, not aggregated", async () => {
    const tokenStore = new CalendarTokenStore(":memory:");
    tokenStore.save("work@example.com", { refreshToken: "r1", accessToken: "work-token", accessTokenExpiresAt: Date.now() + 3_600_000 });
    tokenStore.save("personal@example.com", { refreshToken: "r2", accessToken: "personal-token", accessTokenExpiresAt: Date.now() + 3_600_000 });

    let fetchCalls = 0;
    global.fetch = (async () => {
      fetchCalls++;
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    const { client } = makeClient(tokenStore);
    await client.listUpcomingEvents(10, "work@example.com");

    expect(fetchCalls).toBe(1);
  });

  test("throws a clear error when the explicit account isn't actually linked", async () => {
    const { client } = makeClient(makeLinkedTokenStore());
    await expect(client.listUpcomingEvents(10, "nobody@example.com")).rejects.toThrow(/nobody@example\.com/);
  });
});

describe("GoogleCalendarClient.searchEvents", () => {
  test("throws when no account is linked", async () => {
    const { client } = makeClient();
    await expect(client.searchEvents("dentist")).rejects.toThrow(/no google account linked/i);
  });

  test("sends the query as the `q` param and maps results", async () => {
    let capturedUrl: string | undefined;
    global.fetch = (async (url: string) => {
      capturedUrl = url;
      return new Response(
        JSON.stringify({
          items: [
            {
              id: "ev1",
              summary: "Dentist",
              start: { dateTime: "2026-01-15T09:00:00Z" },
              end: { dateTime: "2026-01-15T09:30:00Z" },
              location: "Clinic",
            },
          ],
        }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const { client } = makeClient(makeLinkedTokenStore());
    const events = await client.searchEvents("dentist");

    expect(new URL(capturedUrl!).searchParams.get("q")).toBe("dentist");
    expect(events).toEqual([
      { id: "ev1", summary: "Dentist", start: "2026-01-15T09:00:00Z", end: "2026-01-15T09:30:00Z", location: "Clinic", account: "me@example.com" },
    ]);
  });

  test("throws on a non-2xx response", async () => {
    global.fetch = (async () => new Response("bad request", { status: 400 })) as unknown as typeof fetch;

    const { client } = makeClient(makeLinkedTokenStore());
    await expect(client.searchEvents("dentist")).rejects.toThrow(/400/);
  });

  test("caps maxResults at 50 even if a larger value is requested", async () => {
    let capturedMaxResults: string | null = null;
    global.fetch = (async (url: string) => {
      capturedMaxResults = new URL(url).searchParams.get("maxResults");
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    const { client } = makeClient(makeLinkedTokenStore());
    await client.searchEvents("dentist", 500);

    expect(capturedMaxResults as unknown as string).toBe("50");
  });
});

describe("GoogleCalendarClient.getEvent", () => {
  test("throws when no account is linked", async () => {
    const { client } = makeClient();
    await expect(client.getEvent("ev1")).rejects.toThrow(/no google account linked/i);
  });

  test("maps the full event including description and attendees, tagged with the account", async () => {
    global.fetch = (async () =>
      new Response(
        JSON.stringify({
          id: "ev1",
          summary: "Team sync",
          description: "Weekly sync",
          location: "Zoom",
          start: { dateTime: "2026-01-15T09:00:00Z" },
          end: { dateTime: "2026-01-15T09:30:00Z" },
          attendees: [{ email: "alice@example.com" }, { email: "bob@example.com" }],
        }),
        { status: 200 }
      )) as unknown as typeof fetch;

    const { client } = makeClient(makeLinkedTokenStore());
    const event = await client.getEvent("ev1");

    expect(event).toEqual({
      id: "ev1",
      summary: "Team sync",
      start: "2026-01-15T09:00:00Z",
      end: "2026-01-15T09:30:00Z",
      location: "Zoom",
      description: "Weekly sync",
      attendees: ["alice@example.com", "bob@example.com"],
      account: "me@example.com",
    });
  });

  test("defaults description to null and attendees to an empty array when absent", async () => {
    global.fetch = (async () =>
      new Response(
        JSON.stringify({ id: "ev2", start: { date: "2026-01-16" }, end: { date: "2026-01-17" } }),
        { status: 200 }
      )) as unknown as typeof fetch;

    const { client } = makeClient(makeLinkedTokenStore());
    const event = await client.getEvent("ev2");

    expect(event.description).toBeNull();
    expect(event.attendees).toEqual([]);
  });

  test("throws on a non-2xx response", async () => {
    global.fetch = (async () => new Response("not found", { status: 404 })) as unknown as typeof fetch;

    const { client } = makeClient(makeLinkedTokenStore());
    await expect(client.getEvent("missing")).rejects.toThrow(/404/);
  });

  test("with more than one linked account and no explicit account, probes each account and finds it wherever it actually is", async () => {
    const tokenStore = new CalendarTokenStore(":memory:");
    tokenStore.save("work@example.com", { refreshToken: "r1", accessToken: "work-token", accessTokenExpiresAt: Date.now() + 3_600_000 });
    tokenStore.save("personal@example.com", { refreshToken: "r2", accessToken: "personal-token", accessTokenExpiresAt: Date.now() + 3_600_000 });

    global.fetch = (async (_url: string, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string>)?.Authorization;
      if (auth === "Bearer work-token") return new Response("not found", { status: 404 });
      return new Response(
        JSON.stringify({ id: "p1", summary: "Dentist", start: { dateTime: "2026-01-15T08:00:00Z" }, end: { dateTime: "2026-01-15T08:30:00Z" } }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const { client } = makeClient(tokenStore);
    const event = await client.getEvent("p1");

    expect(event.account).toBe("personal@example.com");
  });

  test("with more than one linked account, throws a combined error naming every account tried when the event is in none of them", async () => {
    const tokenStore = new CalendarTokenStore(":memory:");
    tokenStore.save("work@example.com", { refreshToken: "r1", accessToken: "work-token", accessTokenExpiresAt: Date.now() + 3_600_000 });
    tokenStore.save("personal@example.com", { refreshToken: "r2", accessToken: "personal-token", accessTokenExpiresAt: Date.now() + 3_600_000 });

    global.fetch = (async () => new Response("not found", { status: 404 })) as unknown as typeof fetch;

    const { client } = makeClient(tokenStore);
    await expect(client.getEvent("missing")).rejects.toThrow(/work@example\.com.*personal@example\.com/s);
  });
});

describe("GoogleCalendarClient.listEventsInRange", () => {
  test("throws when no account is linked", async () => {
    const { client } = makeClient();
    await expect(client.listEventsInRange("2026-01-15T09:00:00Z", "2026-01-15T10:00:00Z")).rejects.toThrow(
      /no google account linked/i
    );
  });

  test("sends timeMin/timeMax and maps overlapping events", async () => {
    let capturedUrl: string | undefined;
    global.fetch = (async (url: string) => {
      capturedUrl = url;
      return new Response(
        JSON.stringify({
          items: [
            {
              id: "ev1",
              summary: "Existing meeting",
              start: { dateTime: "2026-01-15T09:00:00Z" },
              end: { dateTime: "2026-01-15T09:30:00Z" },
            },
          ],
        }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const { client } = makeClient(makeLinkedTokenStore());
    const events = await client.listEventsInRange("2026-01-15T09:00:00Z", "2026-01-15T10:00:00Z");

    expect(new URL(capturedUrl!).searchParams.get("timeMin")).toBe("2026-01-15T09:00:00Z");
    expect(new URL(capturedUrl!).searchParams.get("timeMax")).toBe("2026-01-15T10:00:00Z");
    expect(events).toHaveLength(1);
    expect(events[0]?.summary).toBe("Existing meeting");
  });

  test("throws on a non-2xx response", async () => {
    global.fetch = (async () => new Response("bad request", { status: 400 })) as unknown as typeof fetch;

    const { client } = makeClient(makeLinkedTokenStore());
    await expect(client.listEventsInRange("2026-01-15T09:00:00Z", "2026-01-15T10:00:00Z")).rejects.toThrow(/400/);
  });
});

describe("GoogleCalendarClient.createEvent", () => {
  test("posts the event to the primary (first-linked) account when none is given, and returns the created event, mapped", async () => {
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
      account: "me@example.com",
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

  test("creates on the explicitly given account, not the primary, when more than one is linked", async () => {
    const tokenStore = new CalendarTokenStore(":memory:");
    tokenStore.save("work@example.com", { refreshToken: "r1", accessToken: "work-token", accessTokenExpiresAt: Date.now() + 3_600_000 });
    tokenStore.save("personal@example.com", { refreshToken: "r2", accessToken: "personal-token", accessTokenExpiresAt: Date.now() + 3_600_000 });

    let capturedAuth: string | undefined;
    global.fetch = (async (_url: string, init?: RequestInit) => {
      capturedAuth = (init?.headers as Record<string, string>)?.Authorization;
      return new Response(
        JSON.stringify({ id: "e1", summary: "Test", start: { dateTime: "2026-01-20T10:00:00Z" }, end: { dateTime: "2026-01-20T10:30:00Z" } }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const { client } = makeClient(tokenStore);
    const event = await client.createEvent(
      { summary: "Test", start: "2026-01-20T10:00:00Z", end: "2026-01-20T10:30:00Z" },
      "personal@example.com"
    );

    expect(capturedAuth).toBe("Bearer personal-token");
    expect(event.account).toBe("personal@example.com");
  });

  test("throws a clear error when the explicit account isn't linked", async () => {
    const { client } = makeClient(makeLinkedTokenStore());
    await expect(
      client.createEvent({ summary: "Test", start: "2026-01-20T10:00:00Z", end: "2026-01-20T10:30:00Z" }, "nobody@example.com")
    ).rejects.toThrow(/nobody@example\.com/);
  });
});

describe("GoogleCalendarClient.updateEvent", () => {
  test("sends a PATCH with only the given fields, and maps the result", async () => {
    let capturedMethod: string | undefined;
    let capturedBody: string | undefined;
    global.fetch = (async (_url: string, init?: RequestInit) => {
      capturedMethod = init?.method;
      capturedBody = init?.body as string;
      return new Response(
        JSON.stringify({
          id: "ev1",
          summary: "Dentist (moved)",
          location: "New clinic",
          start: { dateTime: "2026-01-20T11:00:00Z" },
          end: { dateTime: "2026-01-20T11:30:00Z" },
        }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const { client } = makeClient(makeLinkedTokenStore());
    const event = await client.updateEvent("ev1", { start: "2026-01-20T11:00:00Z", end: "2026-01-20T11:30:00Z" });

    expect(capturedMethod).toBe("PATCH");
    const body = JSON.parse(capturedBody!);
    expect(body).toEqual({ start: { dateTime: "2026-01-20T11:00:00Z" }, end: { dateTime: "2026-01-20T11:30:00Z" } });
    expect(event.summary).toBe("Dentist (moved)");
  });

  test("clears location when passed null", async () => {
    let capturedBody: string | undefined;
    global.fetch = (async (_url: string, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return new Response(
        JSON.stringify({ id: "ev1", start: { dateTime: "2026-01-20T11:00:00Z" }, end: { dateTime: "2026-01-20T11:30:00Z" } }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const { client } = makeClient(makeLinkedTokenStore());
    await client.updateEvent("ev1", { location: null });

    expect(JSON.parse(capturedBody!)).toEqual({ location: "" });
  });

  test("throws on a non-2xx response", async () => {
    global.fetch = (async () => new Response("bad request", { status: 400 })) as unknown as typeof fetch;

    const { client } = makeClient(makeLinkedTokenStore());
    await expect(client.updateEvent("ev1", { summary: "New" })).rejects.toThrow(/400/);
  });

  test("with more than one linked account and no explicit account, finds and patches whichever account actually has the event", async () => {
    const tokenStore = new CalendarTokenStore(":memory:");
    tokenStore.save("work@example.com", { refreshToken: "r1", accessToken: "work-token", accessTokenExpiresAt: Date.now() + 3_600_000 });
    tokenStore.save("personal@example.com", { refreshToken: "r2", accessToken: "personal-token", accessTokenExpiresAt: Date.now() + 3_600_000 });

    global.fetch = (async (_url: string, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string>)?.Authorization;
      if (auth === "Bearer work-token") return new Response("not found", { status: 404 });
      if (init?.method === "PATCH") {
        return new Response(
          JSON.stringify({ id: "p1", summary: "Moved", start: { dateTime: "2026-01-20T11:00:00Z" }, end: { dateTime: "2026-01-20T11:30:00Z" } }),
          { status: 200 }
        );
      }
      return new Response(
        JSON.stringify({ id: "p1", summary: "Dentist", start: { dateTime: "2026-01-20T10:00:00Z" }, end: { dateTime: "2026-01-20T10:30:00Z" } }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const { client } = makeClient(tokenStore);
    const event = await client.updateEvent("p1", { start: "2026-01-20T11:00:00Z" });

    expect(event.account).toBe("personal@example.com");
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

  test("deletes from the explicitly given account, without probing the others", async () => {
    const tokenStore = new CalendarTokenStore(":memory:");
    tokenStore.save("work@example.com", { refreshToken: "r1", accessToken: "work-token", accessTokenExpiresAt: Date.now() + 3_600_000 });
    tokenStore.save("personal@example.com", { refreshToken: "r2", accessToken: "personal-token", accessTokenExpiresAt: Date.now() + 3_600_000 });

    let capturedAuth: string | undefined;
    global.fetch = (async (_url: string, init?: RequestInit) => {
      capturedAuth = (init?.headers as Record<string, string>)?.Authorization;
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;

    const { client } = makeClient(tokenStore);
    await client.deleteEvent("event-1", "personal@example.com");

    expect(capturedAuth).toBe("Bearer personal-token");
  });
});
