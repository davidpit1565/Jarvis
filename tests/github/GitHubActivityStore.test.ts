import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { GitHubActivityStore } from "@/github/GitHubActivityStore";

describe("GitHubActivityStore", () => {
  let store: GitHubActivityStore;

  beforeEach(() => {
    store = new GitHubActivityStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  test("getCursor returns undefined for a repo that's never been polled", () => {
    expect(store.getCursor("o", "r")).toBeUndefined();
  });

  test("listRecentActivity is empty before anything is recorded", () => {
    expect(store.listRecentActivity()).toEqual([]);
  });

  test("recordPoll persists the cursor and activity, readable back", () => {
    store.recordPoll(
      "davidpit1565",
      "Jarvis",
      { lastCommitSha: "abc", lastMaxIssueNumber: 5, lastMaxPrNumber: 2 },
      {
        newCommits: [{ sha: "abc", message: "Fix thing", authorName: "David", date: "2026-10-27T00:00:00Z", url: "https://x" }],
        newIssues: [],
        newPullRequests: [],
      },
      "2026-10-27T00:00:00Z"
    );

    expect(store.getCursor("davidpit1565", "Jarvis")).toEqual({
      lastCommitSha: "abc",
      lastMaxIssueNumber: 5,
      lastMaxPrNumber: 2,
    });

    const activity = store.listRecentActivity();
    expect(activity).toHaveLength(1);
    expect(activity[0]!.owner).toBe("davidpit1565");
    expect(activity[0]!.repo).toBe("Jarvis");
    expect(activity[0]!.newCommits).toHaveLength(1);
    expect(activity[0]!.polledAt).toBe("2026-10-27T00:00:00Z");
  });

  test("a repo with no new activity in its latest poll is left out of listRecentActivity", () => {
    store.recordPoll("o", "r", { lastCommitSha: "abc" }, { newCommits: [], newIssues: [], newPullRequests: [] });
    expect(store.listRecentActivity()).toEqual([]);
  });

  test("recordPoll overwrites a previous non-empty activity batch with a new (possibly empty) one — no accumulation", () => {
    store.recordPoll(
      "o",
      "r",
      { lastCommitSha: "a" },
      { newCommits: [{ sha: "a", message: "m1", authorName: null, date: null, url: "u" }], newIssues: [], newPullRequests: [] }
    );
    expect(store.listRecentActivity()).toHaveLength(1);

    // Next poll found nothing new — should clear, not append.
    store.recordPoll("o", "r", { lastCommitSha: "a" }, { newCommits: [], newIssues: [], newPullRequests: [] });
    expect(store.listRecentActivity()).toEqual([]);
  });

  test("tracks multiple repos independently", () => {
    store.recordPoll(
      "o1",
      "r1",
      { lastCommitSha: "a" },
      { newCommits: [{ sha: "a", message: "m", authorName: null, date: null, url: "u" }], newIssues: [], newPullRequests: [] }
    );
    store.recordPoll(
      "o2",
      "r2",
      { lastCommitSha: "b" },
      { newCommits: [{ sha: "b", message: "m2", authorName: null, date: null, url: "u2" }], newIssues: [], newPullRequests: [] }
    );

    const activity = store.listRecentActivity();
    expect(activity).toHaveLength(2);
    const repos = activity.map((a) => `${a.owner}/${a.repo}`).sort();
    expect(repos).toEqual(["o1/r1", "o2/r2"]);
  });
});
