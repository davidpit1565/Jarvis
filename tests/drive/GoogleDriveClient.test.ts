import { describe, test, expect, afterEach } from "bun:test";
import { CalendarTokenStore } from "@/calendar/CalendarTokenStore";
import { GoogleDriveClient } from "@/drive/GoogleDriveClient";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

function makeClient(tokenStore = new CalendarTokenStore(":memory:")) {
  return { client: new GoogleDriveClient("client-id", "client-secret", tokenStore), tokenStore };
}

function makeLinkedTokenStore(email = "me@example.com"): CalendarTokenStore {
  const tokenStore = new CalendarTokenStore(":memory:");
  tokenStore.save(email, { refreshToken: "r1", accessToken: "valid", accessTokenExpiresAt: Date.now() + 3_600_000 });
  return tokenStore;
}

describe("GoogleDriveClient.resolveAccount", () => {
  test("throws when no account is linked", () => {
    const { client } = makeClient();
    expect(() => client.resolveAccount()).toThrow(/no google account linked/i);
  });

  test("throws when an explicit account isn't linked", () => {
    const { client } = makeClient(makeLinkedTokenStore("real@example.com"));
    expect(() => client.resolveAccount("ghost@example.com")).toThrow(/no google account linked as ghost@example.com/i);
  });

  test("defaults to the primary (first-linked) account", () => {
    const { client } = makeClient(makeLinkedTokenStore("primary@example.com"));
    expect(client.resolveAccount()).toBe("primary@example.com");
  });
});

describe("GoogleDriveClient.getValidAccessToken", () => {
  test("refreshes an expired access token", async () => {
    const tokenStore = new CalendarTokenStore(":memory:");
    tokenStore.save("me@example.com", { refreshToken: "refresh-1", accessToken: "expired", accessTokenExpiresAt: Date.now() - 1000 });

    global.fetch = (async (url: string) => {
      expect(url).toContain("oauth2.googleapis.com");
      return new Response(JSON.stringify({ access_token: "refreshed-token", expires_in: 3600 }), { status: 200 });
    }) as unknown as typeof fetch;

    const { client } = makeClient(tokenStore);
    const token = await client.getValidAccessToken("me@example.com");

    expect(token).toBe("refreshed-token");
    expect(tokenStore.get("me@example.com")?.accessToken).toBe("refreshed-token");
  });

  test("reuses a still-valid access token without calling Google", async () => {
    global.fetch = (async () => {
      throw new Error("should not be called");
    }) as unknown as typeof fetch;

    const { client } = makeClient(makeLinkedTokenStore());
    const token = await client.getValidAccessToken("me@example.com");
    expect(token).toBe("valid");
  });
});

describe("GoogleDriveClient.getFile", () => {
  test("maps a file's metadata, tagged with the account", async () => {
    global.fetch = (async (url: string) => {
      expect(url).toContain("/drive/v3/files/file-123");
      return new Response(
        JSON.stringify({ id: "file-123", name: "My Deck", webViewLink: "https://docs.google.com/presentation/d/file-123", mimeType: "application/vnd.google-apps.presentation" }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const { client } = makeClient(makeLinkedTokenStore());
    const file = await client.getFile("file-123");

    expect(file).toEqual({
      id: "file-123",
      name: "My Deck",
      webViewLink: "https://docs.google.com/presentation/d/file-123",
      mimeType: "application/vnd.google-apps.presentation",
      account: "me@example.com",
    });
  });

  test("falls back to a Drive-by-id URL when webViewLink is missing", async () => {
    global.fetch = (async () =>
      new Response(JSON.stringify({ id: "file-456", name: "Untitled", mimeType: "application/vnd.google-apps.document" }), { status: 200 })) as unknown as typeof fetch;

    const { client } = makeClient(makeLinkedTokenStore());
    const file = await client.getFile("file-456");
    expect(file.webViewLink).toBe("https://drive.google.com/file/d/file-456/view");
  });

  test("throws on a non-2xx response", async () => {
    global.fetch = (async () => new Response("not found", { status: 404 })) as unknown as typeof fetch;
    const { client } = makeClient(makeLinkedTokenStore());
    await expect(client.getFile("missing")).rejects.toThrow(/404/);
  });
});

describe("GoogleDriveClient.createFolder", () => {
  test("creates a folder with the right mime type", async () => {
    let capturedBody: Record<string, unknown> = {};
    global.fetch = (async (url: string, init?: RequestInit) => {
      expect(url).toContain("/drive/v3/files");
      capturedBody = JSON.parse(init!.body as string);
      return new Response(JSON.stringify({ id: "folder-1", name: "Projects", mimeType: "application/vnd.google-apps.folder" }), { status: 200 });
    }) as unknown as typeof fetch;

    const { client } = makeClient(makeLinkedTokenStore());
    const folder = await client.createFolder("Projects");

    expect(capturedBody.mimeType).toBe("application/vnd.google-apps.folder");
    expect(capturedBody.name).toBe("Projects");
    expect(folder.id).toBe("folder-1");
  });
});

describe("GoogleDriveClient.findFilesByName", () => {
  test("builds a Drive `contains` query and maps results", async () => {
    let capturedUrl: URL | undefined;
    global.fetch = (async (url: string) => {
      capturedUrl = new URL(url);
      return new Response(JSON.stringify({ files: [{ id: "f1", name: "BFA checklist", mimeType: "application/vnd.google-apps.document" }] }), { status: 200 });
    }) as unknown as typeof fetch;

    const { client } = makeClient(makeLinkedTokenStore());
    const files = await client.findFilesByName("BFA");

    expect(capturedUrl?.searchParams.get("q")).toBe("name contains 'BFA' and trashed = false");
    expect(files).toHaveLength(1);
    expect(files[0]!.name).toBe("BFA checklist");
  });

  test("escapes single quotes in the search term", async () => {
    let capturedQ: string | null = null;
    global.fetch = (async (url: string) => {
      capturedQ = new URL(url).searchParams.get("q") as string | null;
      return new Response(JSON.stringify({ files: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    const { client } = makeClient(makeLinkedTokenStore());
    await client.findFilesByName("David's deck");

    expect(capturedQ as unknown as string).toBe("name contains 'David\\'s deck' and trashed = false");
  });

  test("aggregates across every linked account when none is specified", async () => {
    const tokenStore = new CalendarTokenStore(":memory:");
    tokenStore.save("work@example.com", { refreshToken: "r1", accessToken: "a1", accessTokenExpiresAt: Date.now() + 3_600_000 });
    tokenStore.save("personal@example.com", { refreshToken: "r2", accessToken: "a2", accessTokenExpiresAt: Date.now() + 3_600_000 });

    global.fetch = (async (url: string, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string>)?.Authorization;
      const file = auth === "Bearer a1" ? { id: "w1", name: "Work deck", mimeType: "x" } : { id: "p1", name: "Personal deck", mimeType: "x" };
      return new Response(JSON.stringify({ files: [file] }), { status: 200 });
    }) as unknown as typeof fetch;

    const { client } = makeClient(tokenStore);
    const files = await client.findFilesByName("deck");

    expect(files.map((f) => f.account).sort()).toEqual(["personal@example.com", "work@example.com"]);
  });

  test("throws when no account is linked", async () => {
    const { client } = makeClient();
    await expect(client.findFilesByName("anything")).rejects.toThrow(/no google account linked/i);
  });
});
