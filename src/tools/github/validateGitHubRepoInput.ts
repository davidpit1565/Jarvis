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
