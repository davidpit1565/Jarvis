import { describe, test, expect, afterEach } from "bun:test";
import { GitHubClient } from "@/github/GitHubClient";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

function makeClient(): GitHubClient {
  return new GitHubClient("fake-token");
}

describe("GitHubClient.listRecentCommits", () => {
  test("maps commits and requests the given branch", async () => {
    let requestedUrl = "";
    global.fetch = (async (url: string, init?: RequestInit) => {
      requestedUrl = url;
      expect((init?.headers as Record<string, string>)["Authorization"]).toBe("Bearer fake-token");
      return new Response(
        JSON.stringify([
          {
            sha: "abc123",
            html_url: "https://github.com/davidpit1565/Jarvis/commit/abc123",
            commit: { message: "Fix the thing\n\nLonger body here", author: { name: "David", date: "2026-10-27T00:00:00Z" } },
          },
        ]),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const client = makeClient();
    const commits = await client.listRecentCommits("davidpit1565", "Jarvis", "main", 5);

    expect(requestedUrl).toContain("/repos/davidpit1565/Jarvis/commits");
    expect(requestedUrl).toContain("sha=main");
    expect(requestedUrl).toContain("per_page=5");
    expect(commits).toEqual([
      {
        sha: "abc123",
        message: "Fix the thing",
        authorName: "David",
        date: "2026-10-27T00:00:00Z",
        url: "https://github.com/davidpit1565/Jarvis/commit/abc123",
      },
    ]);
  });

  test("handles a missing commit author gracefully", async () => {
    global.fetch = (async () =>
      new Response(
        JSON.stringify([{ sha: "abc", html_url: "https://github.com/o/r/commit/abc", commit: { message: "msg", author: null } }]),
        { status: 200 }
      )) as unknown as typeof fetch;

    const commits = await makeClient().listRecentCommits("o", "r");
    expect(commits[0]!.authorName).toBeNull();
    expect(commits[0]!.date).toBeNull();
  });

  test("throws a sanitized error on a non-2xx response, not the raw body", async () => {
    global.fetch = (async () => new Response("some internal detail", { status: 404 })) as unknown as typeof fetch;
    await expect(makeClient().listRecentCommits("o", "r")).rejects.toThrow(/404/);
    await expect(makeClient().listRecentCommits("o", "r")).rejects.not.toThrow(/internal detail/);
  });
});

describe("GitHubClient.listOpenIssues", () => {
  test("filters out pull requests returned by the /issues endpoint", async () => {
    global.fetch = (async () =>
      new Response(
        JSON.stringify([
          {
            number: 1,
            title: "A real issue",
            html_url: "https://github.com/o/r/issues/1",
            user: { login: "david" },
            labels: [{ name: "bug" }, "enhancement"],
            created_at: "2026-10-01T00:00:00Z",
            updated_at: "2026-10-02T00:00:00Z",
            comments: 3,
          },
          {
            number: 2,
            title: "Actually a PR",
            html_url: "https://github.com/o/r/pull/2",
            user: { login: "david" },
            labels: [],
            created_at: "2026-10-01T00:00:00Z",
            updated_at: "2026-10-02T00:00:00Z",
            comments: 0,
            pull_request: { url: "https://api.github.com/repos/o/r/pulls/2" },
          },
        ]),
        { status: 200 }
      )) as unknown as typeof fetch;

    const issues = await makeClient().listOpenIssues("o", "r");
    expect(issues).toHaveLength(1);
    expect(issues[0]).toEqual({
      number: 1,
      title: "A real issue",
      url: "https://github.com/o/r/issues/1",
      authorLogin: "david",
      labels: ["bug", "enhancement"],
      createdAt: "2026-10-01T00:00:00Z",
      updatedAt: "2026-10-02T00:00:00Z",
      comments: 3,
    });
  });

  test("handles a missing user gracefully", async () => {
    global.fetch = (async () =>
      new Response(
        JSON.stringify([
          {
            number: 1,
            title: "Issue",
            html_url: "https://github.com/o/r/issues/1",
            user: null,
            labels: [],
            created_at: "2026-10-01T00:00:00Z",
            updated_at: "2026-10-02T00:00:00Z",
            comments: 0,
          },
        ]),
        { status: 200 }
      )) as unknown as typeof fetch;

    const issues = await makeClient().listOpenIssues("o", "r");
    expect(issues[0]!.authorLogin).toBeNull();
  });
});

describe("GitHubClient.listOpenPullRequests", () => {
  test("maps pull requests including draft state and branches", async () => {
    global.fetch = (async () =>
      new Response(
        JSON.stringify([
          {
            number: 5,
            title: "Add feature",
            html_url: "https://github.com/o/r/pull/5",
            user: { login: "david" },
            head: { ref: "feature-branch" },
            base: { ref: "main" },
            draft: true,
            created_at: "2026-10-01T00:00:00Z",
            updated_at: "2026-10-02T00:00:00Z",
          },
        ]),
        { status: 200 }
      )) as unknown as typeof fetch;

    const prs = await makeClient().listOpenPullRequests("o", "r");
    expect(prs).toEqual([
      {
        number: 5,
        title: "Add feature",
        url: "https://github.com/o/r/pull/5",
        authorLogin: "david",
        headBranch: "feature-branch",
        baseBranch: "main",
        draft: true,
        createdAt: "2026-10-01T00:00:00Z",
        updatedAt: "2026-10-02T00:00:00Z",
      },
    ]);
  });
});

describe("GitHubClient.getRepoActivitySummary", () => {
  test("combines commits, issues, and pull requests", async () => {
    global.fetch = (async (url: string) => {
      if (url.includes("/commits")) {
        return new Response(
          JSON.stringify([{ sha: "a", html_url: "u", commit: { message: "m", author: { name: "d", date: "2026-10-27T00:00:00Z" } } }]),
          { status: 200 }
        );
      }
      if (url.includes("/issues")) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.includes("/pulls")) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      return new Response("unexpected", { status: 500 });
    }) as unknown as typeof fetch;

    const summary = await makeClient().getRepoActivitySummary("o", "r");
    expect(summary.owner).toBe("o");
    expect(summary.repo).toBe("r");
    expect(summary.recentCommits).toHaveLength(1);
    expect(summary.openIssues).toEqual([]);
    expect(summary.openPullRequests).toEqual([]);
  });

  test("propagates a failure instead of returning a fabricated empty summary", async () => {
    global.fetch = (async (url: string) => {
      if (url.includes("/commits")) return new Response("error", { status: 500 });
      return new Response(JSON.stringify([]), { status: 200 });
    }) as unknown as typeof fetch;

    await expect(makeClient().getRepoActivitySummary("o", "r")).rejects.toThrow();
  });
});
