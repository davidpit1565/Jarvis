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

describe("GitHubClient.listMyRepos", () => {
  test("requests affiliation=owner and maps full_name/updated_at", async () => {
    let requestedUrl = "";
    global.fetch = (async (url: string) => {
      requestedUrl = url;
      return new Response(
        JSON.stringify([
          { full_name: "davidpit1565/Jarvis", updated_at: "2026-10-27T00:00:00Z" },
          { full_name: "davidpit1565/Rudder", updated_at: "2026-10-26T00:00:00Z" },
        ]),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const repos = await makeClient().listMyRepos();

    expect(requestedUrl).toContain("/user/repos");
    expect(requestedUrl).toContain("affiliation=owner");
    expect(requestedUrl).toContain("page=1");
    expect(repos).toEqual([
      { fullName: "davidpit1565/Jarvis", updatedAt: "2026-10-27T00:00:00Z" },
      { fullName: "davidpit1565/Rudder", updatedAt: "2026-10-26T00:00:00Z" },
    ]);
  });

  test("handles a missing updated_at gracefully", async () => {
    global.fetch = (async () =>
      new Response(JSON.stringify([{ full_name: "o/r" }]), { status: 200 })) as unknown as typeof fetch;

    const repos = await makeClient().listMyRepos();
    expect(repos).toEqual([{ fullName: "o/r", updatedAt: null }]);
  });

  test("paginates across a full page and a short following page", async () => {
    // Page 1 is a full page (100, GitHub's own max per_page), page 2 is
    // short — the short page is what ends the loop here, well under the
    // 200-repo cap, so this exercises genuine multi-page pagination.
    const page1 = Array.from({ length: 100 }, (_, i) => ({ full_name: `o/repo${i}`, updated_at: null }));
    const page2 = [{ full_name: "o/last-repo", updated_at: null }];
    let calls = 0;
    const requestedPages: string[] = [];
    global.fetch = (async (url: string) => {
      calls++;
      const page = new URL(url).searchParams.get("page");
      requestedPages.push(page ?? "");
      return new Response(JSON.stringify(page === "1" ? page1 : page2), { status: 200 });
    }) as unknown as typeof fetch;

    const repos = await makeClient().listMyRepos();

    expect(calls).toBe(2);
    expect(requestedPages).toEqual(["1", "2"]);
    expect(repos).toHaveLength(101);
    expect(repos[100]).toEqual({ fullName: "o/last-repo", updatedAt: null });
  });

  test("stops and logs once the 200-repo cap is hit, never looping unboundedly", async () => {
    let calls = 0;
    global.fetch = (async () => {
      calls++;
      // Always returns a full page — without the cap, this would loop forever.
      const fullPage = Array.from({ length: 100 }, (_, i) => ({ full_name: `o/repo-p${calls}-${i}`, updated_at: null }));
      return new Response(JSON.stringify(fullPage), { status: 200 });
    }) as unknown as typeof fetch;

    const errorSpy = (() => {
      const original = console.error;
      let called = false;
      console.error = (...args: unknown[]) => {
        called = true;
        original(...args);
      };
      return { wasCalled: () => called, restore: () => (console.error = original) };
    })();

    const repos = await makeClient().listMyRepos();

    expect(repos).toHaveLength(200);
    // Exactly two full pages (100 each) are needed to hit the 200 cap,
    // confirming the loop stopped rather than continuing unboundedly.
    expect(calls).toBe(2);
    expect(errorSpy.wasCalled()).toBe(true);
    errorSpy.restore();
  });

  test("an empty account returns an empty list without extra requests", async () => {
    let calls = 0;
    global.fetch = (async () => {
      calls++;
      return new Response(JSON.stringify([]), { status: 200 });
    }) as unknown as typeof fetch;

    const repos = await makeClient().listMyRepos();
    expect(repos).toEqual([]);
    expect(calls).toBe(1);
  });
});

describe("GitHubClient.commentOnIssue", () => {
  test("posts the comment body and maps the response", async () => {
    let requestedUrl = "";
    let requestedInit: RequestInit | undefined;
    global.fetch = (async (url: string, init?: RequestInit) => {
      requestedUrl = url;
      requestedInit = init;
      return new Response(
        JSON.stringify({ id: 42, html_url: "https://github.com/o/r/issues/1#issuecomment-42", body: "hello", created_at: "2026-10-27T00:00:00Z" }),
        { status: 201 }
      );
    }) as unknown as typeof fetch;

    const comment = await makeClient().commentOnIssue("o", "r", 1, "hello");

    expect(requestedUrl).toBe("https://api.github.com/repos/o/r/issues/1/comments");
    expect(requestedInit?.method).toBe("POST");
    expect(JSON.parse(requestedInit?.body as string)).toEqual({ body: "hello" });
    expect(comment).toEqual({ id: 42, url: "https://github.com/o/r/issues/1#issuecomment-42", body: "hello", createdAt: "2026-10-27T00:00:00Z" });
  });

  test("throws a sanitized error on a 404 (issue/repo not found), not the raw body", async () => {
    global.fetch = (async () => new Response("some internal detail", { status: 404 })) as unknown as typeof fetch;
    await expect(makeClient().commentOnIssue("o", "r", 1, "hello")).rejects.toThrow(/404/);
    await expect(makeClient().commentOnIssue("o", "r", 1, "hello")).rejects.not.toThrow(/internal detail/);
  });

  test("surfaces a 403 permission-denied error as a real failure", async () => {
    global.fetch = (async () => new Response("Resource not accessible by personal access token", { status: 403 })) as unknown as typeof fetch;
    await expect(makeClient().commentOnIssue("o", "r", 1, "hello")).rejects.toThrow(/403/);
  });
});

describe("GitHubClient.mergePullRequest", () => {
  test("merges with no options and maps the response", async () => {
    let requestedUrl = "";
    let requestedInit: RequestInit | undefined;
    global.fetch = (async (url: string, init?: RequestInit) => {
      requestedUrl = url;
      requestedInit = init;
      return new Response(JSON.stringify({ sha: "abc123", merged: true, message: "Pull Request successfully merged" }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await makeClient().mergePullRequest("o", "r", 7);

    expect(requestedUrl).toBe("https://api.github.com/repos/o/r/pulls/7/merge");
    expect(requestedInit?.method).toBe("PUT");
    expect(JSON.parse(requestedInit?.body as string)).toEqual({});
    expect(result).toEqual({ sha: "abc123", merged: true, message: "Pull Request successfully merged" });
  });

  test("forwards mergeMethod/commitTitle/commitMessage when given", async () => {
    let requestedInit: RequestInit | undefined;
    global.fetch = (async (_url: string, init?: RequestInit) => {
      requestedInit = init;
      return new Response(JSON.stringify({ sha: "abc", merged: true, message: "ok" }), { status: 200 });
    }) as unknown as typeof fetch;

    await makeClient().mergePullRequest("o", "r", 7, { mergeMethod: "squash", commitTitle: "Title", commitMessage: "Body" });

    expect(JSON.parse(requestedInit?.body as string)).toEqual({ merge_method: "squash", commit_title: "Title", commit_message: "Body" });
  });

  test("surfaces a 405 (not mergeable, e.g. failing checks or branch protection) as a real failure, never a fabricated success", async () => {
    global.fetch = (async () => new Response("Required status check has not passed", { status: 405 })) as unknown as typeof fetch;
    await expect(makeClient().mergePullRequest("o", "r", 7)).rejects.toThrow(/405/);
  });

  test("surfaces a 409 (head sha mismatch / merge conflict) as a real failure", async () => {
    global.fetch = (async () => new Response("Head branch was modified", { status: 409 })) as unknown as typeof fetch;
    await expect(makeClient().mergePullRequest("o", "r", 7)).rejects.toThrow(/409/);
  });

  test("surfaces a 404 as a real failure, with the raw body never leaked", async () => {
    global.fetch = (async () => new Response("internal repo detail", { status: 404 })) as unknown as typeof fetch;
    await expect(makeClient().mergePullRequest("o", "r", 7)).rejects.toThrow(/404/);
    await expect(makeClient().mergePullRequest("o", "r", 7)).rejects.not.toThrow(/internal repo detail/);
  });
});
