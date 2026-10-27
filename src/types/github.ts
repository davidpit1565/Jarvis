/** A single commit on a repo/branch, trimmed to what "what did I push recently" needs. */
export interface GitHubCommit {
  sha: string;
  /** First line of the commit message (the summary), not the full multi-line body. */
  message: string;
  authorName: string | null;
  /** ISO 8601 commit date (the author date GitHub's API reports). */
  date: string | null;
  url: string;
}

/** An open issue — GitHub's REST `issues` endpoint also returns pull requests, which GitHubClient filters out before this shape is built. */
export interface GitHubIssue {
  number: number;
  title: string;
  url: string;
  authorLogin: string | null;
  labels: string[];
  createdAt: string;
  updatedAt: string;
  comments: number;
}

/** An open pull request. */
export interface GitHubPullRequest {
  number: number;
  title: string;
  url: string;
  authorLogin: string | null;
  headBranch: string;
  baseBranch: string;
  draft: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Combined "what's happening in this repo" snapshot — recent commits plus open issues/PRs, for CHECK_GITHUB_REPO_ACTIVITY's convenience summary. */
export interface GitHubRepoActivitySummary {
  owner: string;
  repo: string;
  branch: string;
  recentCommits: GitHubCommit[];
  openIssues: GitHubIssue[];
  openPullRequests: GitHubPullRequest[];
}

/** Result of posting a comment on an issue or pull request (GitHub treats PRs as issues for commenting). */
export interface GitHubComment {
  id: number;
  url: string;
  body: string;
  createdAt: string;
}

/** The three merge strategies GitHub's merge endpoint supports. */
export type GitHubMergeMethod = "merge" | "squash" | "rebase";

/** Result of a successful pull request merge. */
export interface GitHubMergeResult {
  sha: string;
  merged: boolean;
  message: string;
}

/**
 * One repo David owns, as returned by `GitHubClient.listMyRepos` — kept
 * deliberately minimal (just enough for the auto-discovery watch list to
 * build "owner/repo" strings from) rather than mirroring GitHub's full repo
 * object.
 */
export interface GitHubRepoSummary {
  /** "owner/repo", exactly the shape `GITHUB_WATCHED_REPOS` entries use. */
  fullName: string;
  /** ISO 8601 timestamp, or null if GitHub didn't report one — not used by auto-discovery today, kept for future use (e.g. "recently active own repos first"). */
  updatedAt: string | null;
}
