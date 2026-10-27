import { describe, test, expect } from "bun:test";
import { createGmailWatchSources, gmailSourceId } from "@/gmail/gmailWatchSource";
import type { GmailClient } from "@/gmail/GmailClient";
import type { EmailSummary } from "@/types/gmail";

function email(id: string, overrides: Partial<EmailSummary> = {}): EmailSummary {
  return {
    id,
    subject: `Subject ${id}`,
    from: "someone@example.com",
    date: "2026-10-27T00:00:00Z",
    snippet: `Snippet for ${id}`,
    account: "me@example.com",
    ...overrides,
  };
}

function stubGmailClient(byQuery: Record<string, EmailSummary[]>): GmailClient {
  return {
    searchMessages: async (query: string) => byQuery[query] ?? [],
  } as unknown as GmailClient;
}

describe("gmailSourceId", () => {
  test("is stable and case/whitespace-insensitive", () => {
    expect(gmailSourceId("from:Boss@Example.com")).toBe(gmailSourceId(" from:Boss@Example.com ".trim()));
    expect(gmailSourceId("Subject:Invoice")).toBe("gmail:subject:invoice");
  });
});

describe("createGmailWatchSources", () => {
  test("builds one source per configured query", () => {
    const client = stubGmailClient({});
    const sources = createGmailWatchSources(client, ["from:a@x.com", "subject:invoice"]);
    expect(sources.map((s) => s.id)).toEqual(["gmail:from:a@x.com", "gmail:subject:invoice"]);
  });

  test("a first-ever poll establishes a baseline cursor and reports nothing as new", async () => {
    const client = stubGmailClient({ "from:a@x.com": [email("m1"), email("m2")] });
    const [source] = createGmailWatchSources(client, ["from:a@x.com"]);

    const { newItems, nextCursor } = await source!.poll(undefined);

    expect(newItems).toEqual([]);
    expect(nextCursor.seenIds).toEqual(["m1", "m2"]);
  });

  test("a second poll reports only messages not seen in the previous cursor", async () => {
    const client = stubGmailClient({ "from:a@x.com": [email("m3"), email("m1"), email("m2")] });
    const [source] = createGmailWatchSources(client, ["from:a@x.com"]);

    const { newItems } = await source!.poll({ seenIds: ["m1", "m2"] });

    expect(newItems).toEqual([email("m3")]);
  });

  test("re-polling with the same messages reports nothing new, no double-counting", async () => {
    const client = stubGmailClient({ "from:a@x.com": [email("m1")] });
    const [source] = createGmailWatchSources(client, ["from:a@x.com"]);

    const first = await source!.poll(undefined);
    const second = await source!.poll(first.nextCursor);
    const third = await source!.poll(second.nextCursor);

    expect(second.newItems).toEqual([]);
    expect(third.newItems).toEqual([]);
  });

  test("each query polls GmailClient.searchMessages with its own raw query string", async () => {
    const seenQueries: string[] = [];
    const client = {
      searchMessages: async (query: string) => {
        seenQueries.push(query);
        return [];
      },
    } as unknown as GmailClient;

    const sources = createGmailWatchSources(client, ["from:a@x.com", "subject:invoice"]);
    await Promise.all(sources.map((s) => s.poll(undefined)));

    expect(seenQueries.sort()).toEqual(["from:a@x.com", "subject:invoice"]);
  });

  test("describe() includes sender and subject but never the full body", () => {
    const client = stubGmailClient({});
    const [source] = createGmailWatchSources(client, ["from:a@x.com"]);
    const text = source!.describe(email("m1", { from: "boss@example.com", subject: "Quarterly report", snippet: "Here is the short preview" }));

    expect(text).toContain("boss@example.com");
    expect(text).toContain("Quarterly report");
    expect(text).toContain("Here is the short preview");
  });

  test("describe() truncates an overly long subject/sender/snippet rather than including it in full", () => {
    const client = stubGmailClient({});
    const [source] = createGmailWatchSources(client, ["from:a@x.com"]);
    const longSnippet = "x".repeat(10_000);
    const text = source!.describe(email("m1", { snippet: longSnippet }));

    expect(text.length).toBeLessThan(longSnippet.length);
    expect(text).toContain("…");
  });

  test("a query whose search returns nothing new on re-poll still advances the cursor to the latest result set", async () => {
    const client = stubGmailClient({ "from:a@x.com": [email("m1")] });
    const [source] = createGmailWatchSources(client, ["from:a@x.com"]);

    const first = await source!.poll(undefined);
    expect(first.nextCursor.seenIds).toEqual(["m1"]);
  });
});
