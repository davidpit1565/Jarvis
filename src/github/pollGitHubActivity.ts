import type { GitHubClient } from "@/github/GitHubClient";
import type { GitHubActivityStore, GitHubRepoCursor, GitHubNewActivity } from "@/github/GitHubActivityStore";
import type { GitHubCommit, GitHubIssue, GitHubPullRequest } from "@/types/github";

/**
 * How many commits/issues/PRs `getRepoActivitySummary` fetches per repo per
 * poll (its own internal default — see GitHubClient.DEFAULT_RESULTS). Used
 * here only as the "if we didn't find the previous cursor anywhere in this
 * page, there were at least this many new commits" fallback below — kept
 * as a literal rather than importing GitHubClient's private constant.
 */
const FETCH_PAGE_SIZE = 10;

/** Parses "owner/repo" into its parts, or returns undefined for anything that doesn't match that shape — a malformed `GITHUB_WATCHED_REPOS` entry is skipped (and logged), never crashes the poller. */
export function parseWatchedRepo(entry: string): { owner: string; repo: string } | undefined {
  const parts = entry.trim().split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return undefined;
  return { owner: parts[0], repo: parts[1] };
}

function diffCommits(commits: GitHubCommit[], previousSha: string | undefined): GitHubCommit[] {
  // No previous cursor at all means this is the first time this repo has
  // ever been polled — there's no "since last check" baseline yet, so
  // nothing is reported as new (this poll's job is purely to establish
  // that baseline). Reporting the repo's entire recent history as "new"
  // on a first poll would be exactly the fabricated-looking activity the
  // task description warns against.
  if (previousSha === undefined) return [];
  const index = commits.findIndex((c) => c.sha === previousSha);
  // Found: everything before it (commits is newest-first) is new.
  // Not found: either nothing changed (and the previous sha just isn't in
  // this page for some unrelated reason) or more commits happened than
  // this page holds — either way, treating the whole fetched page as new
  // is the safe, bounded-by-FETCH_PAGE_SIZE choice, never unbounded.
  return index === -1 ? commits : commits.slice(0, index);
}

function diffByNumber<T extends { number: number }>(items: T[], previousMax: number | undefined): T[] {
  if (previousMax === undefined) return [];
  return items.filter((item) => item.number > previousMax);
}

function maxNumber(items: Array<{ number: number }>, previous: number | undefined): number | undefined {
  const highest = items.reduce((max, item) => Math.max(max, item.number), previous ?? 0);
  return highest > 0 || previous !== undefined ? highest : undefined;
}

/**
 * Polls every watched repo once, via the existing read-only `GitHubClient`,
 * and records what's new since each repo's last recorded poll into
 * `GitHubActivityStore` — the only network-calling half of proactive
 * GitHub surfacing; `githubActivityNote` never calls the network itself,
 * it only reads what this function already found and cached. See this
 * change's PR description for why polling+caching was chosen over a live
 * call on every conversation turn.
 *
 * Each repo is handled independently and defensively: a failure fetching
 * one repo (network error, rate limit, repo renamed/deleted, GitHub down)
 * is logged and skipped — that repo's previously cached cursor/activity is
 * left untouched rather than cleared or guessed at, and polling continues
 * with the remaining repos. This function itself never throws; a caller
 * (the `setInterval` tick in index.ts) can call it without its own
 * try/catch and still never have a bad poll take down the scheduler.
 */
export async function pollGitHubActivity(
  client: GitHubClient,
  store: GitHubActivityStore,
  watchedRepos: string[],
  onError: (owner: string, repo: string, error: unknown) => void = (owner, repo, error) =>
    console.error(`[jarvis] GitHub activity poll failed for ${owner}/${repo}:`, error instanceof Error ? error.message : String(error))
): Promise<void> {
  for (const entry of watchedRepos) {
    const parsed = parseWatchedRepo(entry);
    if (!parsed) {
      console.error(`[jarvis] GITHUB_WATCHED_REPOS: skipping malformed entry "${entry}" (expected "owner/repo")`);
      continue;
    }
    const { owner, repo } = parsed;

    try {
      const summary = await client.getRepoActivitySummary(owner, repo);
      const previousCursor: GitHubRepoCursor = store.getCursor(owner, repo) ?? {};

      const newCommits = diffCommits(summary.recentCommits, previousCursor.lastCommitSha);
      const newIssues = diffByNumber<GitHubIssue>(summary.openIssues, previousCursor.lastMaxIssueNumber);
      const newPullRequests = diffByNumber<GitHubPullRequest>(summary.openPullRequests, previousCursor.lastMaxPrNumber);

      const nextCursor: GitHubRepoCursor = {
        lastCommitSha: summary.recentCommits[0]?.sha ?? previousCursor.lastCommitSha,
        lastMaxIssueNumber: maxNumber(summary.openIssues, previousCursor.lastMaxIssueNumber),
        lastMaxPrNumber: maxNumber(summary.openPullRequests, previousCursor.lastMaxPrNumber),
      };

      const activity: GitHubNewActivity = { newCommits, newIssues, newPullRequests };
      store.recordPoll(owner, repo, nextCursor, activity);
    } catch (error) {
      onError(owner, repo, error);
    }
  }
}

// Exported for tests that want to assert the page-size assumption without
// hardcoding it twice.
export { FETCH_PAGE_SIZE };
