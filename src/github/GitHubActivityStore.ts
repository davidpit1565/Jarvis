import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
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

interface Row {
  owner: string;
  repo: string;
  last_commit_sha: string | null;
  last_max_issue_number: number | null;
  last_max_pr_number: number | null;
  last_polled_at: string | null;
  new_commits_json: string;
  new_issues_json: string;
  new_prs_json: string;
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
 * Deliberately stores only the *latest* poll's new-activity, not an
 * ever-growing history — the note only ever wants to say "here's what's
 * new since I last checked," not replay a changelog, and an unbounded
 * table here would be the same unbounded-growth failure mode
 * `goalProgressNote.ts`/`correctionNote.ts` already called out and guarded
 * against for their own stores. A poll that finds nothing new overwrites
 * the previous (non-empty) entry with an empty one, which is correct: the
 * note should stop mentioning the earlier commit once a poll has
 * confirmed there's been nothing new since.
 *
 * Same SQLite house style as CommitmentStore/GoalStore (bun:sqlite,
 * WAL mode, mkdirSync for the parent directory).
 */
export class GitHubActivityStore {
  private db: Database;

  constructor(dbPath: string = ":memory:") {
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    if (dbPath !== ":memory:") this.db.run("PRAGMA journal_mode = WAL");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS github_activity_state (
        owner TEXT NOT NULL,
        repo TEXT NOT NULL,
        last_commit_sha TEXT,
        last_max_issue_number INTEGER,
        last_max_pr_number INTEGER,
        last_polled_at TEXT,
        new_commits_json TEXT NOT NULL DEFAULT '[]',
        new_issues_json TEXT NOT NULL DEFAULT '[]',
        new_prs_json TEXT NOT NULL DEFAULT '[]',
        PRIMARY KEY (owner, repo)
      )
    `);
  }

  /** The cursor for one repo, or undefined if it's never been polled (or never recorded a poll result) before. */
  getCursor(owner: string, repo: string): GitHubRepoCursor | undefined {
    const row = this.db
      .query(
        `SELECT owner, repo, last_commit_sha, last_max_issue_number, last_max_pr_number, last_polled_at, new_commits_json, new_issues_json, new_prs_json
         FROM github_activity_state WHERE owner = ? AND repo = ?`
      )
      .get(owner, repo) as Row | null;
    if (!row) return undefined;
    return {
      lastCommitSha: row.last_commit_sha ?? undefined,
      lastMaxIssueNumber: row.last_max_issue_number ?? undefined,
      lastMaxPrNumber: row.last_max_pr_number ?? undefined,
    };
  }

  /** Upserts a repo's cursor and the activity this poll found to be new, replacing whatever the previous poll had recorded. */
  recordPoll(owner: string, repo: string, cursor: GitHubRepoCursor, activity: GitHubNewActivity, polledAt: string = new Date().toISOString()): void {
    this.db
      .query(
        `INSERT INTO github_activity_state
           (owner, repo, last_commit_sha, last_max_issue_number, last_max_pr_number, last_polled_at, new_commits_json, new_issues_json, new_prs_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(owner, repo) DO UPDATE SET
           last_commit_sha = excluded.last_commit_sha,
           last_max_issue_number = excluded.last_max_issue_number,
           last_max_pr_number = excluded.last_max_pr_number,
           last_polled_at = excluded.last_polled_at,
           new_commits_json = excluded.new_commits_json,
           new_issues_json = excluded.new_issues_json,
           new_prs_json = excluded.new_prs_json`
      )
      .run(
        owner,
        repo,
        cursor.lastCommitSha ?? null,
        cursor.lastMaxIssueNumber ?? null,
        cursor.lastMaxPrNumber ?? null,
        polledAt,
        JSON.stringify(activity.newCommits),
        JSON.stringify(activity.newIssues),
        JSON.stringify(activity.newPullRequests)
      );
  }

  /** Every watched repo that currently has *something* new to report (non-empty commits/issues/PRs from its latest poll), ordered by most recently polled first. Repos with nothing new are left out entirely — exactly like a repo that was never polled. */
  listRecentActivity(): GitHubRepoActivityRecord[] {
    const rows = this.db
      .query(
        `SELECT owner, repo, last_commit_sha, last_max_issue_number, last_max_pr_number, last_polled_at, new_commits_json, new_issues_json, new_prs_json
         FROM github_activity_state
         WHERE new_commits_json != '[]' OR new_issues_json != '[]' OR new_prs_json != '[]'
         ORDER BY last_polled_at DESC`
      )
      .all() as Row[];

    return rows.map((row) => ({
      owner: row.owner,
      repo: row.repo,
      polledAt: row.last_polled_at ?? "",
      newCommits: JSON.parse(row.new_commits_json) as GitHubCommit[],
      newIssues: JSON.parse(row.new_issues_json) as GitHubIssue[],
      newPullRequests: JSON.parse(row.new_prs_json) as GitHubPullRequest[],
    }));
  }

  close(): void {
    this.db.close();
  }
}
