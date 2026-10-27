import type { GitHubCommit, GitHubIssue, GitHubPullRequest, GitHubRepoActivitySummary } from "@/types/github";
import { fetchWithRetry } from "@/core/net/fetchWithRetry";
import { apiError } from "@/core/net/apiError";

const GITHUB_API_BASE_URL = "https://api.github.com";

// GitHub's own recommended pinned API version — see
// https://docs.github.com/en/rest/about-the-rest-api/api-versions. Pinning
// means a future GitHub-side default-version bump can never silently change
// this client's response shape out from under it.
const GITHUB_API_VERSION = "2022-11-28";

// Same "cap unbounded results" reasoning as SpotifyClient/GoogleCalendarClient's
// own caps — a caller passing an unreasonably large count shouldn't pull an
// unbounded page of commits/issues/PRs (and their full field set) in one call.
const MAX_RESULTS_CAP = 30;
const DEFAULT_RESULTS = 10;

interface RawGitHubCommit {
  sha: string;
  html_url: string;
  commit: {
    message: string;
    author: { name?: string; date?: string } | null;
  };
}

interface RawGitHubIssue {
  number: number;
  title: string;
  html_url: string;
  user: { login?: string } | null;
  labels: Array<string | { name?: string }>;
  created_at: string;
  updated_at: string;
  comments: number;
  // Present (and non-null) on a pull request returned by the /issues
  // endpoint — GitHub's REST API treats every PR as an issue under the
  // hood, so this is the field used to filter PRs back out.
  pull_request?: unknown;
}

interface RawGitHubPullRequest {
  number: number;
  title: string;
  html_url: string;
  user: { login?: string } | null;
  head: { ref: string };
  base: { ref: string };
  draft: boolean;
  created_at: string;
  updated_at: string;
}

function clampResults(maxResults: number | undefined): number {
  if (maxResults === undefined) return DEFAULT_RESULTS;
  return Math.max(1, Math.min(maxResults, MAX_RESULTS_CAP));
}

/**
 * Read-only GitHub access via raw fetch calls to the REST API (no SDK
 * dependency, matching this codebase's existing style — see
 * GoogleDriveClient/SpotifyClient). Authenticates with a single static
 * token (a fine-grained personal access token — see the PR description
 * for why a PAT was chosen over a GitHub App for this single-user use
 * case) rather than an OAuth flow: unlike Calendar/Gmail/Spotify, there is
 * no per-user consent screen to drive, no refresh token to rotate, and no
 * TokenStore — the token is handed in once at construction, straight from
 * config (GITHUB_TOKEN), the same "one static credential" shape as
 * StudioClient/AgentMailClient.
 *
 * v1 scope is deliberately read-only (recent commits, open issues, open
 * PRs, and a combined activity summary) — see the PR description for why
 * write operations (creating issues, merging PRs) are an explicit
 * follow-up, not part of this change.
 */
export class GitHubClient {
  constructor(private readonly token: string) {}

  private authHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
      "User-Agent": "jarvis-personal-assistant",
    };
  }

  private async get<T>(path: string, params: Record<string, string | number | undefined>, context: string): Promise<T> {
    const url = new URL(`${GITHUB_API_BASE_URL}${path}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const response = await fetchWithRetry(url.toString(), { headers: this.authHeaders() });
    if (!response.ok) {
      throw await apiError(context, response);
    }
    return (await response.json()) as T;
  }

  /** Recent commits on a repo's branch (defaults to the repo's default branch), most recent first. */
  async listRecentCommits(owner: string, repo: string, branch?: string, maxResults?: number): Promise<GitHubCommit[]> {
    const raw = await this.get<RawGitHubCommit[]>(
      `/repos/${owner}/${repo}/commits`,
      { sha: branch, per_page: clampResults(maxResults) },
      `GitHub list commits failed for ${owner}/${repo}`
    );
    return raw.map((c) => ({
      sha: c.sha,
      message: c.commit.message.split("\n")[0] ?? "",
      authorName: c.commit.author?.name ?? null,
      date: c.commit.author?.date ?? null,
      url: c.html_url,
    }));
  }

  /** Open issues on a repo — pull requests (which GitHub's /issues endpoint also returns) are filtered out. */
  async listOpenIssues(owner: string, repo: string, maxResults?: number): Promise<GitHubIssue[]> {
    // Ask for a few extra over the cap since PRs returned by this endpoint
    // get filtered out below and would otherwise under-fill the page.
    const requested = clampResults(maxResults);
    const raw = await this.get<RawGitHubIssue[]>(
      `/repos/${owner}/${repo}/issues`,
      { state: "open", per_page: Math.min(requested * 2, 100) },
      `GitHub list issues failed for ${owner}/${repo}`
    );
    return raw
      .filter((i) => i.pull_request === undefined)
      .slice(0, requested)
      .map((i) => ({
        number: i.number,
        title: i.title,
        url: i.html_url,
        authorLogin: i.user?.login ?? null,
        labels: i.labels.map((l) => (typeof l === "string" ? l : (l.name ?? ""))).filter(Boolean),
        createdAt: i.created_at,
        updatedAt: i.updated_at,
        comments: i.comments,
      }));
  }

  /** Open pull requests on a repo. */
  async listOpenPullRequests(owner: string, repo: string, maxResults?: number): Promise<GitHubPullRequest[]> {
    const raw = await this.get<RawGitHubPullRequest[]>(
      `/repos/${owner}/${repo}/pulls`,
      { state: "open", per_page: clampResults(maxResults) },
      `GitHub list pull requests failed for ${owner}/${repo}`
    );
    return raw.map((p) => ({
      number: p.number,
      title: p.title,
      url: p.html_url,
      authorLogin: p.user?.login ?? null,
      headBranch: p.head.ref,
      baseBranch: p.base.ref,
      draft: p.draft,
      createdAt: p.created_at,
      updatedAt: p.updated_at,
    }));
  }

  /**
   * Convenience combined summary — the three calls above in parallel — for
   * "what's new in my repo" style questions that want commits + issues +
   * PRs in one answer rather than three separate tool calls.
   */
  async getRepoActivitySummary(owner: string, repo: string, branch?: string): Promise<GitHubRepoActivitySummary> {
    const [recentCommits, openIssues, openPullRequests] = await Promise.all([
      this.listRecentCommits(owner, repo, branch, DEFAULT_RESULTS),
      this.listOpenIssues(owner, repo, DEFAULT_RESULTS),
      this.listOpenPullRequests(owner, repo, DEFAULT_RESULTS),
    ]);
    return { owner, repo, branch: branch ?? "default", recentCommits, openIssues, openPullRequests };
  }
}
