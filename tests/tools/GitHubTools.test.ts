import { describe, test, expect, afterEach } from "bun:test";
import { GitHubClient } from "@/github/GitHubClient";
import { createListGitHubCommitsTool } from "@/tools/github/ListGitHubCommitsTool";
import { createListGitHubIssuesTool } from "@/tools/github/ListGitHubIssuesTool";
import { createListGitHubPullRequestsTool } from "@/tools/github/ListGitHubPullRequestsTool";
import { createCheckGitHubRepoActivityTool } from "@/tools/github/CheckGitHubRepoActivityTool";
import { PermissionLevel } from "@/types/permissions";

const context = { userId: "user-1", requestId: "req-1" };
const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

function makeClient(): GitHubClient {
  return new GitHubClient("fake-token");
}

describe("LIST_GITHUB_COMMITS tool", () => {
  test("is READ", () => {
    const tool = createListGitHubCommitsTool(makeClient());
    expect(tool.requiredPermission).toBe(PermissionLevel.READ);
  });

  test("returns commits on success", async () => {
    global.fetch = (async () =>
      new Response(
        JSON.stringify([{ sha: "a", html_url: "u", commit: { message: "m", author: { name: "d", date: "t" } } }]),
        { status: 200 }
      )) as unknown as typeof fetch;

    const tool = createListGitHubCommitsTool(makeClient());
    const result = await tool.execute({ owner: "davidpit1565", repo: "Jarvis" }, context);
    expect(result.success).toBe(true);
    expect((result.data as { commits: unknown[] }).commits).toHaveLength(1);
  });

  test("rejects a missing owner", async () => {
    const tool = createListGitHubCommitsTool(makeClient());
    // @ts-expect-error deliberately missing required field, matching a misbehaving caller
    const result = await tool.execute({ repo: "Jarvis" }, context);
    expect(result.success).toBe(false);
  });

  test("rejects an invalid owner shape (not blindly trusted)", async () => {
    const tool = createListGitHubCommitsTool(makeClient());
    const result = await tool.execute({ owner: "not valid/owner", repo: "Jarvis" }, context);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/owner/i);
  });

  test("rejects an invalid repo shape", async () => {
    const tool = createListGitHubCommitsTool(makeClient());
    const result = await tool.execute({ owner: "davidpit1565", repo: "../etc/passwd" }, context);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/repo/i);
  });

  test("rejects an out-of-range maxResults", async () => {
    const tool = createListGitHubCommitsTool(makeClient());
    const result = await tool.execute({ owner: "davidpit1565", repo: "Jarvis", maxResults: 999 }, context);
    expect(result.success).toBe(false);
  });

  test("returns a real failure (not a fabricated success) when the GitHub API errors", async () => {
    global.fetch = (async () => new Response("error", { status: 500 })) as unknown as typeof fetch;
    const tool = createListGitHubCommitsTool(makeClient());
    const result = await tool.execute({ owner: "davidpit1565", repo: "Jarvis" }, context);
    expect(result.success).toBe(false);
    expect(result.data).toBeUndefined();
  });
});

describe("LIST_GITHUB_ISSUES tool", () => {
  test("is READ", () => {
    const tool = createListGitHubIssuesTool(makeClient());
    expect(tool.requiredPermission).toBe(PermissionLevel.READ);
  });

  test("returns issues on success", async () => {
    global.fetch = (async () => new Response(JSON.stringify([]), { status: 200 })) as unknown as typeof fetch;
    const tool = createListGitHubIssuesTool(makeClient());
    const result = await tool.execute({ owner: "davidpit1565", repo: "BFA" }, context);
    expect(result.success).toBe(true);
    expect((result.data as { issues: unknown[] }).issues).toEqual([]);
  });

  test("rejects an invalid repo", async () => {
    const tool = createListGitHubIssuesTool(makeClient());
    const result = await tool.execute({ owner: "davidpit1565", repo: "" }, context);
    expect(result.success).toBe(false);
  });

  test("surfaces an API failure as a real failure", async () => {
    global.fetch = (async () => new Response("rate limited", { status: 403 })) as unknown as typeof fetch;
    const tool = createListGitHubIssuesTool(makeClient());
    const result = await tool.execute({ owner: "davidpit1565", repo: "BFA" }, context);
    expect(result.success).toBe(false);
  });
});

describe("LIST_GITHUB_PULL_REQUESTS tool", () => {
  test("is READ", () => {
    const tool = createListGitHubPullRequestsTool(makeClient());
    expect(tool.requiredPermission).toBe(PermissionLevel.READ);
  });

  test("returns pull requests on success", async () => {
    global.fetch = (async () => new Response(JSON.stringify([]), { status: 200 })) as unknown as typeof fetch;
    const tool = createListGitHubPullRequestsTool(makeClient());
    const result = await tool.execute({ owner: "davidpit1565", repo: "Rudder" }, context);
    expect(result.success).toBe(true);
    expect((result.data as { pullRequests: unknown[] }).pullRequests).toEqual([]);
  });

  test("rejects a missing repo", async () => {
    const tool = createListGitHubPullRequestsTool(makeClient());
    // @ts-expect-error deliberately missing required field, matching a misbehaving caller
    const result = await tool.execute({ owner: "davidpit1565" }, context);
    expect(result.success).toBe(false);
  });
});

describe("CHECK_GITHUB_REPO_ACTIVITY tool", () => {
  test("is READ", () => {
    const tool = createCheckGitHubRepoActivityTool(makeClient());
    expect(tool.requiredPermission).toBe(PermissionLevel.READ);
  });

  test("returns a combined summary on success", async () => {
    global.fetch = (async () => new Response(JSON.stringify([]), { status: 200 })) as unknown as typeof fetch;
    const tool = createCheckGitHubRepoActivityTool(makeClient());
    const result = await tool.execute({ owner: "davidpit1565", repo: "videos-ai" }, context);
    expect(result.success).toBe(true);
    const data = result.data as { owner: string; repo: string; recentCommits: unknown[]; openIssues: unknown[]; openPullRequests: unknown[] };
    expect(data.owner).toBe("davidpit1565");
    expect(data.repo).toBe("videos-ai");
    expect(data.recentCommits).toEqual([]);
    expect(data.openIssues).toEqual([]);
    expect(data.openPullRequests).toEqual([]);
  });

  test("rejects an invalid branch", async () => {
    const tool = createCheckGitHubRepoActivityTool(makeClient());
    const result = await tool.execute({ owner: "davidpit1565", repo: "videos-ai", branch: "bad branch!" }, context);
    expect(result.success).toBe(false);
  });

  test("never fabricates a success when one of the three underlying calls fails", async () => {
    global.fetch = (async (url: string) => {
      if (url.includes("/pulls")) return new Response("boom", { status: 500 });
      return new Response(JSON.stringify([]), { status: 200 });
    }) as unknown as typeof fetch;

    const tool = createCheckGitHubRepoActivityTool(makeClient());
    const result = await tool.execute({ owner: "davidpit1565", repo: "videos-ai" }, context);
    expect(result.success).toBe(false);
  });
});
