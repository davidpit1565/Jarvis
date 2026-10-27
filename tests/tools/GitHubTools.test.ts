import { describe, test, expect, afterEach } from "bun:test";
import { GitHubClient } from "@/github/GitHubClient";
import { createListGitHubCommitsTool } from "@/tools/github/ListGitHubCommitsTool";
import { createListGitHubIssuesTool } from "@/tools/github/ListGitHubIssuesTool";
import { createListGitHubPullRequestsTool } from "@/tools/github/ListGitHubPullRequestsTool";
import { createCheckGitHubRepoActivityTool } from "@/tools/github/CheckGitHubRepoActivityTool";
import { createCommentOnGitHubIssueTool } from "@/tools/github/CommentOnGitHubIssueTool";
import { createMergeGitHubPullRequestTool } from "@/tools/github/MergeGitHubPullRequestTool";
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

describe("COMMENT_ON_GITHUB_ISSUE tool", () => {
  test("is CONFIRM", () => {
    const tool = createCommentOnGitHubIssueTool(makeClient());
    expect(tool.requiredPermission).toBe(PermissionLevel.CONFIRM);
  });

  test("posts a comment on success", async () => {
    global.fetch = (async () =>
      new Response(
        JSON.stringify({ id: 1, html_url: "https://github.com/o/r/issues/1#issuecomment-1", body: "nice work", created_at: "2026-10-27T00:00:00Z" }),
        { status: 201 }
      )) as unknown as typeof fetch;

    const tool = createCommentOnGitHubIssueTool(makeClient());
    const result = await tool.execute({ owner: "davidpit1565", repo: "Jarvis", issueNumber: 1, body: "nice work" }, context);
    expect(result.success).toBe(true);
    expect((result.data as { body: string }).body).toBe("nice work");
  });

  test("rejects an invalid owner/repo", async () => {
    const tool = createCommentOnGitHubIssueTool(makeClient());
    const result = await tool.execute({ owner: "not valid/owner", repo: "Jarvis", issueNumber: 1, body: "hi" }, context);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/owner/i);
  });

  test("rejects a non-positive-integer issueNumber", async () => {
    const tool = createCommentOnGitHubIssueTool(makeClient());
    const result = await tool.execute({ owner: "davidpit1565", repo: "Jarvis", issueNumber: -1, body: "hi" }, context);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/issueNumber/i);
  });

  test("rejects a non-integer issueNumber", async () => {
    const tool = createCommentOnGitHubIssueTool(makeClient());
    const result = await tool.execute({ owner: "davidpit1565", repo: "Jarvis", issueNumber: 1.5, body: "hi" }, context);
    expect(result.success).toBe(false);
  });

  test("rejects an empty comment body", async () => {
    const tool = createCommentOnGitHubIssueTool(makeClient());
    const result = await tool.execute({ owner: "davidpit1565", repo: "Jarvis", issueNumber: 1, body: "   " }, context);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/body/i);
  });

  test("rejects an oversized comment body", async () => {
    const tool = createCommentOnGitHubIssueTool(makeClient());
    const result = await tool.execute({ owner: "davidpit1565", repo: "Jarvis", issueNumber: 1, body: "x".repeat(4001) }, context);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/body/i);
  });

  test("surfaces a 403 permission-denied GitHub error as a real failure, not a fabricated success", async () => {
    global.fetch = (async () => new Response("Resource not accessible by personal access token", { status: 403 })) as unknown as typeof fetch;
    const tool = createCommentOnGitHubIssueTool(makeClient());
    const result = await tool.execute({ owner: "davidpit1565", repo: "Jarvis", issueNumber: 1, body: "hi" }, context);
    expect(result.success).toBe(false);
    expect(result.data).toBeUndefined();
  });

  test("surfaces a 404 not-found error as a real failure", async () => {
    global.fetch = (async () => new Response("not found", { status: 404 })) as unknown as typeof fetch;
    const tool = createCommentOnGitHubIssueTool(makeClient());
    const result = await tool.execute({ owner: "davidpit1565", repo: "Jarvis", issueNumber: 999999, body: "hi" }, context);
    expect(result.success).toBe(false);
  });
});

describe("MERGE_GITHUB_PULL_REQUEST tool", () => {
  test("is DANGEROUS", () => {
    const tool = createMergeGitHubPullRequestTool(makeClient());
    expect(tool.requiredPermission).toBe(PermissionLevel.DANGEROUS);
  });

  test("merges on success with no options", async () => {
    global.fetch = (async () =>
      new Response(JSON.stringify({ sha: "abc123", merged: true, message: "Pull Request successfully merged" }), { status: 200 })) as unknown as typeof fetch;

    const tool = createMergeGitHubPullRequestTool(makeClient());
    const result = await tool.execute({ owner: "davidpit1565", repo: "Jarvis", pullNumber: 7 }, context);
    expect(result.success).toBe(true);
    expect((result.data as { merged: boolean }).merged).toBe(true);
  });

  test("merges with an explicit mergeMethod", async () => {
    let requestedInit: RequestInit | undefined;
    global.fetch = (async (_url: string, init?: RequestInit) => {
      requestedInit = init;
      return new Response(JSON.stringify({ sha: "abc", merged: true, message: "ok" }), { status: 200 });
    }) as unknown as typeof fetch;

    const tool = createMergeGitHubPullRequestTool(makeClient());
    const result = await tool.execute({ owner: "davidpit1565", repo: "Jarvis", pullNumber: 7, mergeMethod: "squash" }, context);
    expect(result.success).toBe(true);
    expect(JSON.parse(requestedInit?.body as string)).toEqual({ merge_method: "squash" });
  });

  test("rejects an invalid mergeMethod", async () => {
    const tool = createMergeGitHubPullRequestTool(makeClient());
    const result = await tool.execute(
      // @ts-expect-error deliberately invalid mergeMethod, matching a misbehaving caller
      { owner: "davidpit1565", repo: "Jarvis", pullNumber: 7, mergeMethod: "rewrite-history" },
      context
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/mergeMethod/i);
  });

  test("rejects a non-positive-integer pullNumber", async () => {
    const tool = createMergeGitHubPullRequestTool(makeClient());
    const result = await tool.execute({ owner: "davidpit1565", repo: "Jarvis", pullNumber: 0 }, context);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/pullNumber/i);
  });

  test("surfaces a 405 (not mergeable: failing checks / branch protection) as a real failure, never a fabricated success", async () => {
    global.fetch = (async () => new Response("Required status check has not passed", { status: 405 })) as unknown as typeof fetch;
    const tool = createMergeGitHubPullRequestTool(makeClient());
    const result = await tool.execute({ owner: "davidpit1565", repo: "Jarvis", pullNumber: 7 }, context);
    expect(result.success).toBe(false);
    expect(result.data).toBeUndefined();
  });

  test("surfaces a 409 (merge conflict / head sha mismatch) as a real failure", async () => {
    global.fetch = (async () => new Response("Head branch was modified", { status: 409 })) as unknown as typeof fetch;
    const tool = createMergeGitHubPullRequestTool(makeClient());
    const result = await tool.execute({ owner: "davidpit1565", repo: "Jarvis", pullNumber: 7 }, context);
    expect(result.success).toBe(false);
  });

  test("surfaces a 404 not-found error as a real failure", async () => {
    global.fetch = (async () => new Response("not found", { status: 404 })) as unknown as typeof fetch;
    const tool = createMergeGitHubPullRequestTool(makeClient());
    const result = await tool.execute({ owner: "davidpit1565", repo: "Jarvis", pullNumber: 999999 }, context);
    expect(result.success).toBe(false);
  });
});
