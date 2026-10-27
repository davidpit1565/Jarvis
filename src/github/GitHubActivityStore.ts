import { WatcherStore } from "@/watcher/WatcherStore";
import type { GitHubCommit, GitHubIssue, GitHubPullRequest } from "@/types/github";

/** The per-repo "where did we leave off" cursor, persisted between polls. `undefined` for a field means that repo has never had a commit/issue/PR observed on it (or has never been polled at all). */
export interface GitHubRepoCursor {
  lastCommitSha?: string;
  lastMaxIssueNumber?: number;
  lastMaxPrNumber?: number;
}

/** What a single poll found that's new since the previous poll's cursor — already capped to what GitHubClient's own default page size returns. */
export interface GitHubNewActivity {
  newCommits: GitHubCommit[];
  newIssues: GitHubIssue[];
  newPullRequests: GitHubPullRequest[];
}

export interface GitHubRepoActivityRecord extends GitHubNewActivity {
  owner: string;
  repo: string;
  /** ISO 8601 timestamp of the poll that produced this record. */
  polledAt: string;
}

/**
 * The flat, tagged item shape actually persisted in `WatcherStore` for a
 * GitHub source — commits/issues/PRs interleaved into one list so they can
 * go through the generic store's single `newItems` column, then split back
 * out by `kind` in `listRecentActivity` to reconstruct the exact
 * `newCommits`/`newIssues`/`newPullRequests` shape this class's own public
 * API has always returned.
 */
type GitHubActivityItem =
  | { kind: "commit"; data: GitHubCommit }
  | { kind: "issue"; data: GitHubIssue }
  | { kind: "pr"; data: GitHubPullRequest };

const SOURCE_PREFIX = "github:";

function toSourceId(owner: string, repo: string): string {
  return `${SOURCE_PREFIX}${owner}/${repo}`;
}

function fromSourceId(sourceId: string): { owner: string; repo: string } {
  const rest = sourceId.slice(SOURCE_PREFIX.length);
  const slashIndex = rest.indexOf("/");
  return { owner: rest.slice(0, slashIndex), repo: rest.slice(slashIndex + 1) };
}

/**
 * Persists, per watched repo, (a) the cursor the poller needs to tell
 * "new since last check" apart from "already seen" and (b) the activity
 * the most recent poll actually found that was new — so `githubActivityNote`
 * can read a cheap, synchronous, already-computed answer instead of ever
 * making a live GitHub API call itself (see `pollGitHubActivity`'s own doc
 * comment for why a live call per conversation turn is a latency/
 * reliability concern this store exists to avoid).
 *
 * Refactored (per CLAUDE.md's "Approved for build: generalized Proactive
 * Watcher" spec) onto the generic `WatcherStore` — this class is now a
 * thin adapter: it translates its owner/repo-keyed, three-categories-of-
 * activity public API into `WatcherStore`'s generic
 * source-id/cursor/flat-items shape, and back. The public API
 * (`getCursor`/`recordPoll`/`listRecentActivity`/`close`) and every
 * observable behavior are unchanged from before this refactor — see the
 * introducing PR description for why this was done as an adapter rather
 * than changing `pollGitHubActivity.ts`/`githubActivityNote.ts`'s own
 * interfaces, and the full pre-existing test suite for confirmation it
 * still passes unmodified.
 */
export class GitHubActivityStore {
  private watcherStore: WatcherStore;

  constructor(dbPath: string = ":memory:") {
    this.watcherStore = new WatcherStore(dbPath);
  }

  /** The cursor for one repo, or undefined if it's never been polled (or never recorded a poll result) before. */
  getCursor(owner: string, repo: string): GitHubRepoCursor | undefined {
    return this.watcherStore.getCursor<GitHubRepoCursor>(toSourceId(owner, repo));
  }

  /** Upserts a repo's cursor and the activity this poll found to be new, replacing whatever the previous poll had recorded. */
  recordPoll(owner: string, repo: string, cursor: GitHubRepoCursor, activity: GitHubNewActivity, polledAt: string = new Date().toISOString()): void {
    const items: GitHubActivityItem[] = [
      ...activity.newCommits.map((data): GitHubActivityItem => ({ kind: "commit", data })),
      ...activity.newIssues.map((data): GitHubActivityItem => ({ kind: "issue", data })),
      ...activity.newPullRequests.map((data): GitHubActivityItem => ({ kind: "pr", data })),
    ];
    this.watcherStore.recordPoll(toSourceId(owner, repo), cursor, items, polledAt);
  }

  /** Every watched repo that currently has *something* new to report (non-empty commits/issues/PRs from its latest poll), ordered by most recently polled first. Repos with nothing new are left out entirely — exactly like a repo that was never polled. */
  listRecentActivity(): GitHubRepoActivityRecord[] {
    return this.watcherStore
      .listWithActivity<GitHubActivityItem>()
      .filter((record) => record.sourceId.startsWith(SOURCE_PREFIX))
      .map((record) => {
        const { owner, repo } = fromSourceId(record.sourceId);
        return {
          owner,
          repo,
          polledAt: record.polledAt,
          newCommits: record.newItems.filter((item): item is Extract<GitHubActivityItem, { kind: "commit" }> => item.kind === "commit").map((item) => item.data),
          newIssues: record.newItems.filter((item): item is Extract<GitHubActivityItem, { kind: "issue" }> => item.kind === "issue").map((item) => item.data),
          newPullRequests: record.newItems.filter((item): item is Extract<GitHubActivityItem, { kind: "pr" }> => item.kind === "pr").map((item) => item.data),
        };
      });
  }

  close(): void {
    this.watcherStore.close();
  }
}
