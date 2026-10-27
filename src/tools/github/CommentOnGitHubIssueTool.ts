import { PermissionLevel } from "@/types/permissions";
import type { LocalTool } from "@/types/tools";
import type { GitHubClient } from "@/github/GitHubClient";
import { validateGitHubRepoInput, validateIssueOrPullNumber, validateCommentBody } from "@/tools/github/validateGitHubRepoInput";

export interface CommentOnGitHubIssueInput extends Record<string, unknown> {
  owner: string;
  repo: string;
  issueNumber: number;
  body: string;
}

/**
 * Posts a comment on a GitHub issue or pull request (GitHub's REST API
 * treats a PR as an issue for commenting purposes, so this one tool
 * covers both — pass a PR's number as `issueNumber`).
 *
 * CONFIRM-tier: a real, publicly visible write to David's own GitHub
 * account. Visible (and a little embarrassing if wrong) but not
 * structurally damaging the way a merge is — see MERGE_GITHUB_PULL_REQUEST
 * for why that one is tiered higher. A standing CONFIRM grant here still
 * means every call gets asked about, per PermissionService's own CONFIRM/
 * DANGEROUS semantics.
 */
export function createCommentOnGitHubIssueTool(githubClient: GitHubClient): LocalTool<CommentOnGitHubIssueInput> {
  return {
    id: "COMMENT_ON_GITHUB_ISSUE",
    name: "comment_on_github_issue",
    description:
      "Posts a comment on a GitHub issue or pull request. Pass a pull request's number as issueNumber to comment on a PR " +
      "(GitHub treats PRs as issues for commenting). This is a real, publicly visible post to the repository.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "The repository owner's GitHub username or organization name, e.g. \"davidpit1565\"." },
        repo: { type: "string", description: "The repository name, e.g. \"Jarvis\"." },
        issueNumber: { type: "number", description: "The issue or pull request number to comment on." },
        body: { type: "string", description: "The comment text (Markdown supported), up to 4000 characters." },
      },
      required: ["owner", "repo", "issueNumber", "body"],
    },
    requiredPermission: PermissionLevel.CONFIRM,
    target: "local",

    async execute(input) {
      const repoValidated = validateGitHubRepoInput(input);
      if (!repoValidated.valid) {
        return { success: false, error: repoValidated.reason };
      }
      const numberValidated = validateIssueOrPullNumber(input.issueNumber);
      if (!numberValidated.valid) {
        return { success: false, error: numberValidated.reason };
      }
      const bodyValidated = validateCommentBody(input.body);
      if (!bodyValidated.valid) {
        return { success: false, error: bodyValidated.reason };
      }

      try {
        const comment = await githubClient.commentOnIssue(repoValidated.owner, repoValidated.repo, numberValidated.value, bodyValidated.value);
        return { success: true, data: comment };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
