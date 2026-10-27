import { describe, test, expect, afterEach } from "bun:test";
import crypto from "node:crypto";
import { CanvaTokenStore } from "@/canva/CanvaTokenStore";
import { CanvaClient } from "@/canva/CanvaClient";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

function makeClient(tokenStore = new CanvaTokenStore(":memory:"), pollOptions = { pollIntervalMs: 0, maxPollAttempts: 3 }) {
  return {
    client: new CanvaClient("client-id", "client-secret", "https://example.com/canva/oauth/callback", tokenStore, pollOptions),
    tokenStore,
  };
}

function makeLinkedTokenStore(): CanvaTokenStore {
  const tokenStore = new CanvaTokenStore(":memory:");
  tokenStore.save({ refreshToken: "r1", accessToken: "valid", accessTokenExpiresAt: Date.now() + 3_600_000 });
  return tokenStore;
}

describe("CanvaClient.buildAuthUrl", () => {
  test("includes PKCE challenge, client id, redirect uri, scopes, and state", () => {
    const { client } = makeClient();
    const { url, codeVerifier } = client.buildAuthUrl("state-123");
    const parsed = new URL(url);

    expect(parsed.hostname).toBe("www.canva.com");
    expect(parsed.searchParams.get("client_id")).toBe("client-id");
    expect(parsed.searchParams.get("redirect_uri")).toBe("https://example.com/canva/oauth/callback");
    expect(parsed.searchParams.get("state")).toBe("state-123");
    expect(parsed.searchParams.get("response_type")).toBe("code");
    expect(parsed.searchParams.get("code_challenge_method")).toBe("s256");
    expect(parsed.searchParams.get("scope")).toContain("design:meta:read");

    // The returned code_verifier must actually hash (SHA-256, base64url) to the code_challenge in the URL.
    const expectedChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
    expect(parsed.searchParams.get("code_challenge")).toBe(expectedChallenge);
    expect(codeVerifier.length).toBeGreaterThanOrEqual(43);
    expect(codeVerifier.length).toBeLessThanOrEqual(128);
  });

  test("generates a fresh code_verifier on every call", () => {
    const { client } = makeClient();
    const first = client.buildAuthUrl("state-1");
    const second = client.buildAuthUrl("state-2");
    expect(first.codeVerifier).not.toBe(second.codeVerifier);
  });
});

describe("CanvaClient.exchangeCodeForTokens", () => {
  test("persists tokens on success", async () => {
    const { client, tokenStore } = makeClient();
    global.fetch = (async () =>
      new Response(JSON.stringify({ access_token: "a1", refresh_token: "r1", expires_in: 14400 }), { status: 200 })) as unknown as typeof fetch;

    await client.exchangeCodeForTokens("code-1", "verifier-1");
    expect(tokenStore.isLinked()).toBe(true);
  });

  test("sends the code_verifier in the token request body", async () => {
    const { client } = makeClient();
    let capturedBody = "";
    global.fetch = (async (_url: string, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return new Response(JSON.stringify({ access_token: "a1", refresh_token: "r1", expires_in: 14400 }), { status: 200 });
    }) as unknown as typeof fetch;

    await client.exchangeCodeForTokens("code-1", "verifier-1");
    const params = new URLSearchParams(capturedBody);
    expect(params.get("code_verifier")).toBe("verifier-1");
    expect(params.get("grant_type")).toBe("authorization_code");
    expect(params.get("code")).toBe("code-1");
  });

  test("throws when Canva doesn't return a refresh token", async () => {
    const { client } = makeClient();
    global.fetch = (async () =>
      new Response(JSON.stringify({ access_token: "a1", expires_in: 14400 }), { status: 200 })) as unknown as typeof fetch;

    await expect(client.exchangeCodeForTokens("code-1", "verifier-1")).rejects.toThrow(/refresh token/i);
  });

  test("throws on a non-2xx response", async () => {
    const { client } = makeClient();
    global.fetch = (async () => new Response("bad request", { status: 400 })) as unknown as typeof fetch;
    await expect(client.exchangeCodeForTokens("code-1", "verifier-1")).rejects.toThrow(/400/);
  });
});

describe("CanvaClient token refresh", () => {
  function makeExpiredTokenStore(): CanvaTokenStore {
    const tokenStore = new CanvaTokenStore(":memory:");
    tokenStore.save({ refreshToken: "old-refresh", accessToken: "stale", accessTokenExpiresAt: Date.now() - 1_000 });
    return tokenStore;
  }

  test("rotates the refresh token on every refresh", async () => {
    const tokenStore = makeExpiredTokenStore();
    const { client } = makeClient(tokenStore);
    global.fetch = (async (url: string) =>
      url.includes("oauth/token")
        ? new Response(JSON.stringify({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 14400 }), { status: 200 })
        : new Response(JSON.stringify({ items: [] }), { status: 200 })) as unknown as typeof fetch;

    await client.listDesigns();

    expect(tokenStore.get()?.refreshToken).toBe("new-refresh");
  });

  test("throws clearly when the refresh response omits a new refresh token", async () => {
    const tokenStore = makeExpiredTokenStore();
    const { client } = makeClient(tokenStore);
    global.fetch = (async () =>
      new Response(JSON.stringify({ access_token: "new-access", expires_in: 14400 }), { status: 200 })) as unknown as typeof fetch;

    await expect(client.listDesigns()).rejects.toThrow(/refresh token/i);
  });

  test("throws on a non-2xx refresh response", async () => {
    const tokenStore = makeExpiredTokenStore();
    const { client } = makeClient(tokenStore);
    global.fetch = (async () => new Response("bad", { status: 401 })) as unknown as typeof fetch;
    await expect(client.listDesigns()).rejects.toThrow(/401/);
  });
});

describe("CanvaClient.listDesigns", () => {
  test("throws when no account is linked", async () => {
    const { client } = makeClient();
    await expect(client.listDesigns()).rejects.toThrow(/no canva account linked/i);
  });

  test("parses designs from the API response", async () => {
    const { client } = makeClient(makeLinkedTokenStore());
    global.fetch = (async () =>
      new Response(
        JSON.stringify({
          items: [
            {
              id: "DAF123",
              title: "My BFA Deck",
              urls: { edit_url: "https://canva.com/edit", view_url: "https://canva.com/view" },
              updated_at: 1700000000,
              design_types: ["presentation"],
            },
          ],
        }),
        { status: 200 }
      )) as unknown as typeof fetch;

    const designs = await client.listDesigns();
    expect(designs).toEqual([
      {
        id: "DAF123",
        title: "My BFA Deck",
        editUrl: "https://canva.com/edit",
        viewUrl: "https://canva.com/view",
        updatedAt: 1700000000,
        designTypes: ["presentation"],
      },
    ]);
  });

  test("throws on a non-2xx response", async () => {
    const { client } = makeClient(makeLinkedTokenStore());
    global.fetch = (async () => new Response("error", { status: 500 })) as unknown as typeof fetch;
    await expect(client.listDesigns()).rejects.toThrow(/500/);
  });
});

describe("CanvaClient.listBrandTemplates", () => {
  test("parses brand templates from the API response", async () => {
    const { client } = makeClient(makeLinkedTokenStore());
    global.fetch = (async () =>
      new Response(
        JSON.stringify({
          items: [
            { id: "BT1", title: "BFA Report Template", view_url: "https://canva.com/view", create_url: "https://canva.com/create" },
          ],
        }),
        { status: 200 }
      )) as unknown as typeof fetch;

    const templates = await client.listBrandTemplates();
    expect(templates).toEqual([
      { id: "BT1", title: "BFA Report Template", viewUrl: "https://canva.com/view", createUrl: "https://canva.com/create" },
    ]);
  });
});

describe("CanvaClient.createDesignFromBrandTemplate", () => {
  test("sends text-typed fields and returns the completed design on immediate success", async () => {
    const { client } = makeClient(makeLinkedTokenStore());
    let capturedBody: Record<string, unknown> | undefined;
    global.fetch = (async (url: string, init?: RequestInit) => {
      if (url.endsWith("/autofills")) {
        capturedBody = JSON.parse(init?.body as string);
        return new Response(JSON.stringify({ job: { id: "job-1", status: "in_progress" } }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          job: {
            id: "job-1",
            status: "success",
            result: {
              type: "create_design",
              design: {
                id: "DAF999",
                title: "My Checklist",
                url: "https://www.canva.com/design/DAF999/edit",
                urls: { edit_url: "https://canva.com/edit", view_url: "https://canva.com/view" },
              },
            },
          },
        }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const design = await client.createDesignFromBrandTemplate("BT1", { headline: "Hello" });

    expect(capturedBody).toEqual({
      type: "create_from_brand_template",
      brand_template_id: "BT1",
      data: { headline: { type: "text", text: "Hello" } },
    });
    expect(design).toEqual({
      id: "DAF999",
      title: "My Checklist",
      url: "https://www.canva.com/design/DAF999/edit",
      editUrl: "https://canva.com/edit",
      viewUrl: "https://canva.com/view",
    });
  });

  test("polls until success across multiple in_progress responses", async () => {
    const { client } = makeClient(makeLinkedTokenStore());
    let pollCount = 0;
    global.fetch = (async (url: string) => {
      if (url.endsWith("/autofills")) {
        return new Response(JSON.stringify({ job: { id: "job-1", status: "in_progress" } }), { status: 200 });
      }
      pollCount++;
      if (pollCount < 2) {
        return new Response(JSON.stringify({ job: { id: "job-1", status: "in_progress" } }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          job: {
            id: "job-1",
            status: "success",
            result: {
              type: "create_design",
              design: { id: "DAF1", urls: { edit_url: "https://canva.com/edit", view_url: "https://canva.com/view" } },
            },
          },
        }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const design = await client.createDesignFromBrandTemplate("BT1", { headline: "Hello" });
    expect(design.id).toBe("DAF1");
    expect(pollCount).toBe(2);
  });

  test("throws with the job's own error message on a failed job", async () => {
    const { client } = makeClient(makeLinkedTokenStore());
    global.fetch = (async (url: string) => {
      if (url.endsWith("/autofills")) {
        return new Response(JSON.stringify({ job: { id: "job-1", status: "in_progress" } }), { status: 200 });
      }
      return new Response(
        JSON.stringify({ job: { id: "job-1", status: "failed", error: { code: "autofill_error", message: "Something broke" } } }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    await expect(client.createDesignFromBrandTemplate("BT1", { headline: "Hello" })).rejects.toThrow(/something broke/i);
  });

  test("throws a clear timeout error when the job never resolves within maxPollAttempts", async () => {
    const { client } = makeClient(makeLinkedTokenStore(), { pollIntervalMs: 0, maxPollAttempts: 2 });
    global.fetch = (async () =>
      new Response(JSON.stringify({ job: { id: "job-1", status: "in_progress" } }), { status: 200 })) as unknown as typeof fetch;

    await expect(client.createDesignFromBrandTemplate("BT1", { headline: "Hello" })).rejects.toThrow(/still in progress/i);
  });

  test("throws on a non-2xx create response", async () => {
    const { client } = makeClient(makeLinkedTokenStore());
    global.fetch = (async () => new Response("bad request", { status: 400 })) as unknown as typeof fetch;
    await expect(client.createDesignFromBrandTemplate("BT1", { headline: "Hello" })).rejects.toThrow(/400/);
  });
});

describe("CanvaClient.exportDesign", () => {
  test("defaults to pdf and returns the completed export's download urls", async () => {
    const { client } = makeClient(makeLinkedTokenStore());
    let capturedBody: Record<string, unknown> | undefined;
    global.fetch = (async (url: string, init?: RequestInit) => {
      if (url.endsWith("/exports")) {
        capturedBody = JSON.parse(init?.body as string);
        return new Response(JSON.stringify({ job: { id: "export-1", status: "in_progress" } }), { status: 200 });
      }
      return new Response(
        JSON.stringify({ job: { id: "export-1", status: "success", urls: ["https://export-download.canva.com/file.pdf"] } }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const result = await client.exportDesign("DAF123");

    expect(capturedBody).toEqual({ design_id: "DAF123", format: { type: "pdf" } });
    expect(result).toEqual({ id: "export-1", format: "pdf", urls: ["https://export-download.canva.com/file.pdf"] });
  });

  test("sends pages when provided", async () => {
    const { client } = makeClient(makeLinkedTokenStore());
    let capturedBody: Record<string, unknown> | undefined;
    global.fetch = (async (url: string, init?: RequestInit) => {
      if (url.endsWith("/exports")) {
        capturedBody = JSON.parse(init?.body as string);
        return new Response(JSON.stringify({ job: { id: "export-1", status: "success", urls: ["https://x/1.pdf"] } }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ job: { id: "export-1", status: "success", urls: ["https://x/1.pdf"] } }), { status: 200 });
    }) as unknown as typeof fetch;

    await client.exportDesign("DAF123", "pdf", { pages: [2, 3] });
    expect(capturedBody).toEqual({ design_id: "DAF123", format: { type: "pdf", pages: [2, 3] } });
  });

  test("defaults jpg quality when not provided", async () => {
    const { client } = makeClient(makeLinkedTokenStore());
    let capturedBody: Record<string, unknown> | undefined;
    global.fetch = (async (url: string, init?: RequestInit) => {
      if (url.endsWith("/exports")) {
        capturedBody = JSON.parse(init?.body as string);
      }
      return new Response(JSON.stringify({ job: { id: "export-1", status: "success", urls: ["https://x/1.jpg"] } }), { status: 200 });
    }) as unknown as typeof fetch;

    await client.exportDesign("DAF123", "jpg");
    expect(capturedBody).toEqual({ design_id: "DAF123", format: { type: "jpg", quality: 90 } });
  });

  test("respects an explicit jpg quality", async () => {
    const { client } = makeClient(makeLinkedTokenStore());
    let capturedBody: Record<string, unknown> | undefined;
    global.fetch = (async (url: string, init?: RequestInit) => {
      if (url.endsWith("/exports")) {
        capturedBody = JSON.parse(init?.body as string);
      }
      return new Response(JSON.stringify({ job: { id: "export-1", status: "success", urls: ["https://x/1.jpg"] } }), { status: 200 });
    }) as unknown as typeof fetch;

    await client.exportDesign("DAF123", "jpg", { jpgQuality: 50 });
    expect(capturedBody).toEqual({ design_id: "DAF123", format: { type: "jpg", quality: 50 } });
  });

  test("polls until success across multiple in_progress responses", async () => {
    const { client } = makeClient(makeLinkedTokenStore());
    let pollCount = 0;
    global.fetch = (async (url: string) => {
      if (url.endsWith("/exports")) {
        return new Response(JSON.stringify({ job: { id: "export-1", status: "in_progress" } }), { status: 200 });
      }
      pollCount++;
      if (pollCount < 2) {
        return new Response(JSON.stringify({ job: { id: "export-1", status: "in_progress" } }), { status: 200 });
      }
      return new Response(JSON.stringify({ job: { id: "export-1", status: "success", urls: ["https://x/1.pdf"] } }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await client.exportDesign("DAF123");
    expect(result.urls).toEqual(["https://x/1.pdf"]);
    expect(pollCount).toBe(2);
  });

  test("throws with the job's own error message on a failed job", async () => {
    const { client } = makeClient(makeLinkedTokenStore());
    global.fetch = (async (url: string) => {
      if (url.endsWith("/exports")) {
        return new Response(JSON.stringify({ job: { id: "export-1", status: "in_progress" } }), { status: 200 });
      }
      return new Response(
        JSON.stringify({ job: { id: "export-1", status: "failed", error: { code: "license_required", message: "Pro plan needed" } } }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    await expect(client.exportDesign("DAF123")).rejects.toThrow(/pro plan needed/i);
  });

  test("throws a clear timeout error when the job never resolves within maxPollAttempts", async () => {
    const { client } = makeClient(makeLinkedTokenStore(), { pollIntervalMs: 0, maxPollAttempts: 2 });
    global.fetch = (async () =>
      new Response(JSON.stringify({ job: { id: "export-1", status: "in_progress" } }), { status: 200 })) as unknown as typeof fetch;

    await expect(client.exportDesign("DAF123")).rejects.toThrow(/still in progress/i);
  });

  test("throws on a non-2xx create response", async () => {
    const { client } = makeClient(makeLinkedTokenStore());
    global.fetch = (async () => new Response("bad request", { status: 400 })) as unknown as typeof fetch;
    await expect(client.exportDesign("DAF123")).rejects.toThrow(/400/);
  });

  test("throws when no account is linked", async () => {
    const { client } = makeClient();
    await expect(client.exportDesign("DAF123")).rejects.toThrow(/no canva account linked/i);
  });
});
