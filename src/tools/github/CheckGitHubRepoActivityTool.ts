import { PermissionLevel } from "@/types/permissions";
import type { LocalTool } from "@/types/tools";
import type { GitHubClient } from "@/github/GitHubClient";
import { validateGitHubRepoInput } from "@/tools/github/validateGitHubRepoInput";

export interface CheckGitHubRepoActivityInput extends Record<string, unknown> {
  owner: string;
  repo: string;
  branch?: string;
}

/**
 * Lets Claude answer broad "what's new in my <repo>" / "catch me up on
 * <repo>" style questions with one call instead of three — a combined
 * snapshot of recent commits, open issues, and open pull requests. This is
 * also the natural building block for proactively surfacing relevant
 * project context unprompted (see CLAUDE.md's "continuous personal
 * profile" background — watching David's own repos and surfacing what
 * might interest him without being asked), though wiring that proactive
 * surfacing in is a separate, later piece of work; this tool only exposes
 * the read.
 *
 * READ-level: purely informational, no side effects.
 */
export function createCheckGitHubRepoActivityTool(githubClient: GitHubClient): LocalTool<CheckGitHubRepoActivityInput> {
  return {
    id: "CHECK_GITHUB_REPO_ACTIVITY",
    name: "check_github_repo_activity",
    description:
      "Returns a combined snapshot of a GitHub repository's recent activity: its most recent commits, currently open issues, " +
      "and currently open pull requests, in one call. Use this for broad \"what's new in my <repo>\" / \"catch me up on <repo>\" " +
      "questions; use list_github_commits/list_github_issues/list_github_pull_requests instead when only one of those is needed.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "The repository owner's GitHub username or organization name, e.g. \"davidpit1565\"." },
        repo: { type: "string", description: "The repository name, e.g. \"Jarvis\"." },
        branch: { type: "string", description: "Branch to read recent commits from. Defaults to the repo's default branch." },
      },
      required: ["owner", "repo"],
    },
    requiredPermission: PermissionLevel.READ,
    target: "local",

    async execute(input) {
      const validated = validateGitHubRepoInput(input);
      if (!validated.valid) {
        return { success: false, error: validated.reason };
      }

      try {
        const summary = await githubClient.getRepoActivitySummary(validated.owner, validated.repo, validated.branch);
        return { success: true, data: summary };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
