import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { GitHubActivityStore } from "@/github/GitHubActivityStore";
import { githubActivityNote } from "@/github/githubActivityNote";

function commit(sha: string): { sha: string; message: string; authorName: string | null; date: string | null; url: string } {
  return { sha, message: `commit ${sha}`, authorName: "David", date: "2026-10-27T00:00:00Z", url: `https://x/${sha}` };
}

describe("githubActivityNote", () => {
  let store: GitHubActivityStore;

  beforeEach(() => {
    store = new GitHubActivityStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  test("returns undefined when nothing is cached", () => {
    expect(githubActivityNote(store)).toBeUndefined();
  });

  test("returns undefined when every watched repo's latest poll found nothing new", () => {
    store.recordPoll("o", "r", { lastCommitSha: "a" }, { newCommits: [], newIssues: [], newPullRequests: [] });
    expect(githubActivityNote(store)).toBeUndefined();
  });

  test("surfaces new commits/issues/PRs for a repo with activity", () => {
    store.recordPoll(
      "davidpit1565",
      "Jarvis",
      { lastCommitSha: "c1" },
      {
        newCommits: [commit("c1")],
        newIssues: [{ number: 7, title: "Bug report", url: "u", authorLogin: null, labels: [], createdAt: "x", updatedAt: "x", comments: 0 }],
        newPullRequests: [],
      }
    );

    const note = githubActivityNote(store)!;
    expect(note).toBeDefined();
    expect(note).toContain("davidpit1565/Jarvis");
    expect(note).toContain("commit c1");
    expect(note).toContain("#7");
    expect(note).toContain("Bug report");
  });

  test("caps the number of items shown per repo with an honest '+N more' note", () => {
    store.recordPoll(
      "o",
      "r",
      { lastCommitSha: "c5" },
      {
        newCommits: [commit("c5"), commit("c4"), commit("c3"), commit("c2"), commit("c1")],
        newIssues: [],
        newPullRequests: [],
      }
    );

    const note = githubActivityNote(store)!;
    expect(note).toContain("5 new commit(s)");
    expect(note).toMatch(/plus 2 more not shown/);
  });

  test("caps the number of repos shown with an honest '+N more repo(s)' note", () => {
    for (let i = 0; i < 6; i++) {
      store.recordPoll(`o${i}`, `r${i}`, { lastCommitSha: `c${i}` }, { newCommits: [commit(`c${i}`)], newIssues: [], newPullRequests: [] });
    }

    const note = githubActivityNote(store)!;
    expect(note).toBeDefined();
    const repoLines = note.split("\n").filter((line) => line.startsWith("- "));
    expect(repoLines.length).toBeLessThan(6);
    expect(note).toContain("6 of the user's GitHub repo(s)");
    expect(note).toMatch(/more repo\(s\) with new activity not shown/);
  });
});
