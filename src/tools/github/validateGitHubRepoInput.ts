// GitHub username/org rules: alphanumeric or single hyphens, 1-39 chars,
// cannot start or end with a hyphen. Repo name rules are looser (GitHub
// allows alphanumeric plus ./-/_), capped at 100 chars. Branch names are
// validated more loosely (they can contain slashes, e.g. "feature/x") but
// still bounded in length and character set to reject anything that isn't
// plausibly a real ref name before it ever reaches a URL.
const OWNER_PATTERN = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/;
const REPO_PATTERN = /^[a-zA-Z0-9._-]{1,100}$/;
const BRANCH_PATTERN = /^[a-zA-Z0-9._/-]{1,250}$/;
const MAX_RESULTS_LIMIT = 30;

/**
 * Shared input validation for every GitHub tool — never trusts a
 * caller-supplied owner/repo/branch string blindly (per the task's own
 * instruction), rejecting anything that doesn't plausibly look like a real
 * GitHub identifier before it's interpolated into an API URL.
 */
export function validateGitHubRepoInput(input: {
  owner?: unknown;
  repo?: unknown;
  branch?: unknown;
  maxResults?: unknown;
}): { valid: true; owner: string; repo: string; branch?: string; maxResults?: number } | { valid: false; reason: string } {
  const { owner, repo, branch, maxResults } = input;

  if (typeof owner !== "string" || !OWNER_PATTERN.test(owner)) {
    return { valid: false, reason: "owner must be a valid GitHub username/organization name (1-39 alphanumeric characters or hyphens)" };
  }
  if (typeof repo !== "string" || !REPO_PATTERN.test(repo)) {
    return { valid: false, reason: "repo must be a valid GitHub repository name (letters, digits, '.', '-' or '_', up to 100 characters)" };
  }
  if (branch !== undefined && (typeof branch !== "string" || !BRANCH_PATTERN.test(branch))) {
    return { valid: false, reason: "branch must be a valid branch/ref name" };
  }
  if (maxResults !== undefined) {
    if (typeof maxResults !== "number" || !Number.isInteger(maxResults) || maxResults < 1 || maxResults > MAX_RESULTS_LIMIT) {
      return { valid: false, reason: `maxResults must be an integer between 1 and ${MAX_RESULTS_LIMIT}` };
    }
  }

  return {
    valid: true,
    owner,
    repo,
    branch: branch as string | undefined,
    maxResults: maxResults as number | undefined,
  };
}

// GitHub issue/PR numbers are always positive integers. 1,000,000 is a
// generous, still-bounded ceiling — no real repo has anywhere near that
// many issues/PRs, so anything above it is certainly not a real number and
// rejecting it early avoids interpolating an implausible value into a URL.
const MAX_ISSUE_OR_PR_NUMBER = 1_000_000;

// Matches AgentMailClient/GmailClient's MAX_BODY_LENGTH convention for
// user-authored free text sent to an external service — a GitHub comment
// body has no good reason to be longer than this in normal use, and
// capping it avoids ever accidentally posting something absurdly long
// (and publicly visible) to a real repo.
export const MAX_COMMENT_BODY_LENGTH = 4000;

/** Validates an issue/PR number (used by both commenting and merging). */
export function validateIssueOrPullNumber(value: unknown): { valid: true; value: number } | { valid: false; reason: string } {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_ISSUE_OR_PR_NUMBER) {
    return { valid: false, reason: "issueNumber/pullNumber must be a positive integer" };
  }
  return { valid: true, value };
}

/** Validates a comment body: a non-empty string within a sane length cap. */
export function validateCommentBody(value: unknown): { valid: true; value: string } | { valid: false; reason: string } {
  if (typeof value !== "string" || value.trim().length === 0) {
    return { valid: false, reason: "body must be a non-empty string" };
  }
  if (value.length > MAX_COMMENT_BODY_LENGTH) {
    return { valid: false, reason: `body must be at most ${MAX_COMMENT_BODY_LENGTH} characters` };
  }
  return { valid: true, value };
}

const MERGE_METHODS = ["merge", "squash", "rebase"] as const;

/** Validates the optional merge options object for MERGE_GITHUB_PULL_REQUEST. */
export function validateMergeOptions(input: {
  mergeMethod?: unknown;
  commitTitle?: unknown;
  commitMessage?: unknown;
}):
  | { valid: true; mergeMethod?: (typeof MERGE_METHODS)[number]; commitTitle?: string; commitMessage?: string }
  | { valid: false; reason: string } {
  const { mergeMethod, commitTitle, commitMessage } = input;

  if (mergeMethod !== undefined && (typeof mergeMethod !== "string" || !(MERGE_METHODS as readonly string[]).includes(mergeMethod))) {
    return { valid: false, reason: `mergeMethod must be one of: ${MERGE_METHODS.join(", ")}` };
  }
  if (commitTitle !== undefined && (typeof commitTitle !== "string" || commitTitle.length > MAX_COMMENT_BODY_LENGTH)) {
    return { valid: false, reason: `commitTitle must be a string of at most ${MAX_COMMENT_BODY_LENGTH} characters` };
  }
  if (commitMessage !== undefined && (typeof commitMessage !== "string" || commitMessage.length > MAX_COMMENT_BODY_LENGTH)) {
    return { valid: false, reason: `commitMessage must be a string of at most ${MAX_COMMENT_BODY_LENGTH} characters` };
  }

  return {
    valid: true,
    mergeMethod: mergeMethod as (typeof MERGE_METHODS)[number] | undefined,
    commitTitle: commitTitle as string | undefined,
    commitMessage: commitMessage as string | undefined,
  };
}
