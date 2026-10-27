import type {
  GitHubComment,
  GitHubCommit,
  GitHubIssue,
  GitHubMergeMethod,
  GitHubMergeResult,
  GitHubPullRequest,
  GitHubRepoActivitySummary,
  GitHubRepoSummary,
} from "@/types/github";
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

// GitHub's own max page size for /user/repos. Requesting the max here isn't
// "unbounded" in the MAX_RESULTS_CAP sense above — it's just the most
// efficient page size; MAX_OWN_REPOS_CAP below is the actual bound on total
// repos considered.
const REPOS_PER_PAGE = 100;

// Same "cap unbounded results" reasoning as MAX_RESULTS_CAP above, applied
// to listMyRepos: a GitHub account with an unusually large number of owned
// repos shouldn't make the auto-discovery watcher (GITHUB_WATCH_ALL_OWN_REPOS)
// poll an unbounded, ever-growing list every cycle. 200 comfortably covers a
// real personal account (deliberately set above REPOS_PER_PAGE so the
// pagination loop can actually span more than one page before the cap ever
// bites — a cap equal to the page size would make genuine pagination
// unreachable); listMyRepos logs when this cap is actually hit.
const MAX_OWN_REPOS_CAP = 200;

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

interface RawGitHubComment {
  id: number;
  html_url: string;
  body: string;
  created_at: string;
}

interface RawGitHubMergeResult {
  sha: string;
  merged: boolean;
  message: string;
}

interface RawGitHubRepo {
  full_name: string;
  updated_at?: string | null;
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
 * v1 scope was deliberately read-only (recent commits, open issues, open
 * PRs, and a combined activity summary). This follow-up adds a narrow set
 * of write operations — commenting on an issue/PR and merging a PR — for
 * interacting with EXISTING repos/issues/PRs only; creating issues,
 * creating branches, deleting anything, or creating/configuring new repos
 * remain explicitly out of scope (see the PR description).
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

  /**
   * Shared write helper (POST/PUT) for the two write operations below.
   * Deliberately NOT retried by fetchWithRetry's usual semantics for
   * mutating calls that aren't idempotent (a comment POST retried after a
   * network blip could double-post) — see commentOnIssue/mergePullRequest,
   * which call plain fetch directly instead of going through this path for
   * that reason. Kept here only as the shared request-building/error
   * surfacing logic, not as a retrying call.
   */
  private async write<T>(method: "POST" | "PUT", path: string, body: Record<string, unknown>, context: string): Promise<T> {
    const response = await fetch(`${GITHUB_API_BASE_URL}${path}`, {
      method,
      headers: { ...this.authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
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

  /**
   * Lists every repo David actually OWNS (`affiliation=owner` — deliberately
   * excludes repos he merely collaborates on or belongs to via an
   * organization, so GITHUB_WATCH_ALL_OWN_REPOS never starts polling a repo
   * he doesn't control). Paginates through GitHub's `/user/repos` endpoint
   * (100 per page, GitHub's own max) up to `MAX_OWN_REPOS_CAP` total repos —
   * if the account actually has more owned repos than that, the result is
   * truncated and a warning is logged rather than looping unboundedly.
   *
   * Used by the proactive GitHub watcher's auto-discovery mode, not by any
   * on-demand tool — on-demand repo reads/writes (listRecentCommits et al.)
   * already work on any named repo the token can see and were never limited
   * to an owned-repos list in the first place.
   */
  async listMyRepos(): Promise<GitHubRepoSummary[]> {
    const repos: GitHubRepoSummary[] = [];
    let page = 1;
    while (repos.length < MAX_OWN_REPOS_CAP) {
      const raw = await this.get<RawGitHubRepo[]>(
        "/user/repos",
        { affiliation: "owner", per_page: REPOS_PER_PAGE, page, sort: "updated" },
        "GitHub list my repos failed"
      );
      if (raw.length === 0) break;
      for (const r of raw) {
        if (repos.length >= MAX_OWN_REPOS_CAP) break;
        repos.push({ fullName: r.full_name, updatedAt: r.updated_at ?? null });
      }
      if (raw.length < REPOS_PER_PAGE) break;
      page++;
    }
    if (repos.length >= MAX_OWN_REPOS_CAP) {
      console.error(`[jarvis] GitHub listMyRepos: hit the ${MAX_OWN_REPOS_CAP}-repo cap — some owned repos may be missing from auto-discovery`);
    }
    return repos;
  }

  /**
   * Posts a comment on an issue or pull request. GitHub's REST API treats
   * every pull request as an issue for commenting purposes (same
   * `/issues/{number}/comments` endpoint works for both — confirmed
   * against GitHub's current REST docs), so this one method covers both.
   *
   * Write operation — CONFIRM-tier at the tool layer (see
   * CommentOnGitHubIssueTool): visible and a little embarrassing if wrong,
   * but not structurally damaging the way a merge is.
   */
  async commentOnIssue(owner: string, repo: string, issueNumber: number, body: string): Promise<GitHubComment> {
    const raw = await this.write<RawGitHubComment>(
      "POST",
      `/repos/${owner}/${repo}/issues/${issueNumber}/comments`,
      { body },
      `GitHub comment failed for ${owner}/${repo}#${issueNumber}`
    );
    return { id: raw.id, url: raw.html_url, body: raw.body, createdAt: raw.created_at };
  }

  /**
   * Merges a pull request. Defaults to GitHub's own default merge
   * behavior (a plain merge commit, with GitHub's own auto-generated
   * commit title/message) when `options` doesn't specify otherwise —
   * callers shouldn't be forced to compose a commit message just to merge.
   *
   * GitHub's merge endpoint already refuses (rather than silently
   * force-passing) a PR that isn't mergeable: `405` when the merge cannot
   * be performed at all (e.g. required checks haven't passed, merging is
   * blocked by branch protection), `409` when a caller-supplied `sha`
   * doesn't match the PR's current head (a safety check against merging
   * the wrong commit if the PR changed underneath the caller), `404` if
   * the PR/repo doesn't exist or the token can't see it, `403` if the
   * token lacks permission. None of these are swallowed — `write()` throws
   * a real error (status code preserved, raw body logged server-side only
   * per apiError's own reasoning) for any non-2xx response, so a blocked
   * merge always surfaces as a real tool failure, never a fabricated
   * success.
   */
  async mergePullRequest(
    owner: string,
    repo: string,
    pullNumber: number,
    options?: { mergeMethod?: GitHubMergeMethod; commitTitle?: string; commitMessage?: string; sha?: string }
  ): Promise<GitHubMergeResult> {
    const body: Record<string, unknown> = {};
    if (options?.mergeMethod) body.merge_method = options.mergeMethod;
    if (options?.commitTitle) body.commit_title = options.commitTitle;
    if (options?.commitMessage) body.commit_message = options.commitMessage;
    if (options?.sha) body.sha = options.sha;

    const raw = await this.write<RawGitHubMergeResult>(
      "PUT",
      `/repos/${owner}/${repo}/pulls/${pullNumber}/merge`,
      body,
      `GitHub merge failed for ${owner}/${repo}#${pullNumber}`
    );
    return { sha: raw.sha, merged: raw.merged, message: raw.message };
  }
}
