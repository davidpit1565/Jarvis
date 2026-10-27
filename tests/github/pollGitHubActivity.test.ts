import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { GitHubActivityStore } from "@/github/GitHubActivityStore";
import { pollGitHubActivity, parseWatchedRepo, resolveWatchedRepos } from "@/github/pollGitHubActivity";
import type { GitHubClient } from "@/github/GitHubClient";
import type { GitHubRepoActivitySummary, GitHubRepoSummary } from "@/types/github";

function makeSummary(overrides: Partial<GitHubRepoActivitySummary> = {}): GitHubRepoActivitySummary {
  return {
    owner: "davidpit1565",
    repo: "Jarvis",
    branch: "default",
    recentCommits: [],
    openIssues: [],
    openPullRequests: [],
    ...overrides,
  };
}

function commit(sha: string): GitHubRepoActivitySummary["recentCommits"][number] {
  return { sha, message: `commit ${sha}`, authorName: "David", date: "2026-10-27T00:00:00Z", url: `https://x/${sha}` };
}

function issue(n: number): GitHubRepoActivitySummary["openIssues"][number] {
  return { number: n, title: `Issue ${n}`, url: `https://x/issues/${n}`, authorLogin: "david", labels: [], createdAt: "2026-10-27T00:00:00Z", updatedAt: "2026-10-27T00:00:00Z", comments: 0 };
}

function pr(n: number): GitHubRepoActivitySummary["openPullRequests"][number] {
  return { number: n, title: `PR ${n}`, url: `https://x/pull/${n}`, authorLogin: "david", headBranch: "f", baseBranch: "main", draft: false, createdAt: "2026-10-27T00:00:00Z", updatedAt: "2026-10-27T00:00:00Z" };
}

/** A minimal stub satisfying the one GitHubClient method the poller uses. */
function stubClient(summaries: Record<string, GitHubRepoActivitySummary | (() => GitHubRepoActivitySummary)>): GitHubClient {
  return {
    getRepoActivitySummary: async (owner: string, repo: string) => {
      const key = `${owner}/${repo}`;
      const entry = summaries[key];
      if (!entry) throw new Error(`no stub for ${key}`);
      return typeof entry === "function" ? entry() : entry;
    },
  } as unknown as GitHubClient;
}

describe("parseWatchedRepo", () => {
  test("parses a valid owner/repo entry", () => {
    expect(parseWatchedRepo("davidpit1565/Jarvis")).toEqual({ owner: "davidpit1565", repo: "Jarvis" });
  });

  test("rejects entries without exactly one slash", () => {
    expect(parseWatchedRepo("no-slash")).toBeUndefined();
    expect(parseWatchedRepo("too/many/slashes")).toBeUndefined();
    expect(parseWatchedRepo("/missing-owner")).toBeUndefined();
    expect(parseWatchedRepo("missing-repo/")).toBeUndefined();
  });
});

/** A minimal stub satisfying the one GitHubClient method resolveWatchedRepos uses. */
function stubListMyRepos(result: GitHubRepoSummary[] | (() => Promise<GitHubRepoSummary[]>)): GitHubClient {
  return {
    listMyRepos: async () => (typeof result === "function" ? result() : result),
  } as unknown as GitHubClient;
}

describe("resolveWatchedRepos", () => {
  test("returns the explicit list unchanged when auto-discovery is off, without calling listMyRepos", async () => {
    let called = false;
    const client = {
      listMyRepos: async () => {
        called = true;
        return [];
      },
    } as unknown as GitHubClient;

    const result = await resolveWatchedRepos(client, ["a/b", "c/d"], false);

    expect(result).toEqual(["a/b", "c/d"]);
    expect(called).toBe(false);
  });

  test("unions explicit repos with auto-discovered owned repos, deduped", async () => {
    const client = stubListMyRepos([
      { fullName: "davidpit1565/Jarvis", updatedAt: null },
      { fullName: "davidpit1565/Rudder", updatedAt: null },
    ]);

    // "davidpit1565/Jarvis" appears in both the explicit list and the
    // auto-discovered list — must appear only once in the result.
    const result = await resolveWatchedRepos(client, ["davidpit1565/Jarvis", "someone-else/collab-repo"], true);

    expect(new Set(result)).toEqual(new Set(["davidpit1565/Jarvis", "davidpit1565/Rudder", "someone-else/collab-repo"]));
    expect(result).toHaveLength(3);
  });

  test("works with an empty explicit list, auto-discovery only", async () => {
    const client = stubListMyRepos([{ fullName: "davidpit1565/Jarvis", updatedAt: null }]);
    const result = await resolveWatchedRepos(client, [], true);
    expect(result).toEqual(["davidpit1565/Jarvis"]);
  });

  test("falls back to the explicit list, not crashing, when auto-discovery fails", async () => {
    const client = stubListMyRepos(() => {
      throw new Error("GitHub rate limited");
    });

    const errors: unknown[] = [];
    const result = await resolveWatchedRepos(client, ["a/b"], true, (error) => errors.push(error));

    expect(result).toEqual(["a/b"]);
    expect(errors).toHaveLength(1);
  });

  test("falling back when auto-discovery fails and the explicit list is also empty yields an empty list, not a crash", async () => {
    const client = stubListMyRepos(() => {
      throw new Error("GitHub down");
    });

    await expect(resolveWatchedRepos(client, [], true, () => {})).resolves.toEqual([]);
  });
});

describe("pollGitHubActivity", () => {
  let store: GitHubActivityStore;

  beforeEach(() => {
    store = new GitHubActivityStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  test("a first-ever poll establishes a baseline cursor and reports nothing as new", async () => {
    const client = stubClient({
      "davidpit1565/Jarvis": makeSummary({ recentCommits: [commit("c3"), commit("c2"), commit("c1")], openIssues: [issue(5)], openPullRequests: [pr(2)] }),
    });

    await pollGitHubActivity(client, store, ["davidpit1565/Jarvis"]);

    expect(store.listRecentActivity()).toEqual([]);
    expect(store.getCursor("davidpit1565", "Jarvis")).toEqual({ lastCommitSha: "c3", lastMaxIssueNumber: 5, lastMaxPrNumber: 2 });
  });

  test("a second poll with new commits/issues/PRs correctly records only what's new", async () => {
    let call = 0;
    const client = stubClient({
      "davidpit1565/Jarvis": () => {
        call++;
        if (call === 1) return makeSummary({ recentCommits: [commit("c1")], openIssues: [issue(1)], openPullRequests: [pr(1)] });
        return makeSummary({
          recentCommits: [commit("c3"), commit("c2"), commit("c1")],
          openIssues: [issue(2), issue(1)],
          openPullRequests: [pr(2), pr(1)],
        });
      },
    });

    await pollGitHubActivity(client, store, ["davidpit1565/Jarvis"]);
    await pollGitHubActivity(client, store, ["davidpit1565/Jarvis"]);

    const activity = store.listRecentActivity();
    expect(activity).toHaveLength(1);
    expect(activity[0]!.newCommits.map((c) => c.sha)).toEqual(["c3", "c2"]);
    expect(activity[0]!.newIssues.map((i) => i.number)).toEqual([2]);
    expect(activity[0]!.newPullRequests.map((p) => p.number)).toEqual([2]);
  });

  test("re-polling with nothing new does not double-count or re-report old activity", async () => {
    const client = stubClient({
      "davidpit1565/Jarvis": makeSummary({ recentCommits: [commit("c1")], openIssues: [issue(1)], openPullRequests: [pr(1)] }),
    });

    // First poll: baseline.
    await pollGitHubActivity(client, store, ["davidpit1565/Jarvis"]);
    expect(store.listRecentActivity()).toEqual([]);

    // Second poll: same exact state — nothing new.
    await pollGitHubActivity(client, store, ["davidpit1565/Jarvis"]);
    expect(store.listRecentActivity()).toEqual([]);

    // Third poll: still nothing new.
    await pollGitHubActivity(client, store, ["davidpit1565/Jarvis"]);
    expect(store.listRecentActivity()).toEqual([]);
  });

  test("a repo whose API call fails is skipped without touching its cached state, and other repos still poll", async () => {
    const client = stubClient({
      "ok/repo": makeSummary({ recentCommits: [commit("c1")] }),
      "bad/repo": () => {
        throw new Error("GitHub API down");
      },
    });

    // Seed "bad/repo" with a prior successful poll's state first.
    store.recordPoll("bad", "repo", { lastCommitSha: "old" }, { newCommits: [], newIssues: [], newPullRequests: [] });

    const errors: Array<{ owner: string; repo: string }> = [];
    await pollGitHubActivity(client, store, ["ok/repo", "bad/repo"], (owner, repo) => errors.push({ owner, repo }));

    expect(errors).toEqual([{ owner: "bad", repo: "repo" }]);
    // bad/repo's cursor is untouched, not cleared or corrupted.
    expect(store.getCursor("bad", "repo")).toEqual({ lastCommitSha: "old" });
    // ok/repo still polled successfully despite bad/repo's failure.
    expect(store.getCursor("ok", "repo")).toEqual({ lastCommitSha: "c1" });
  });

  test("never throws even when every repo fails", async () => {
    const client = stubClient({});
    await expect(pollGitHubActivity(client, store, ["nonexistent/repo"], () => {})).resolves.toBeUndefined();
  });

  test("a malformed watched-repo entry is skipped, not crashed on", async () => {
    const client = stubClient({ "ok/repo": makeSummary({ recentCommits: [commit("c1")] }) });
    await pollGitHubActivity(client, store, ["not-a-valid-entry", "ok/repo"]);
    expect(store.getCursor("ok", "repo")).toEqual({ lastCommitSha: "c1" });
  });
});
