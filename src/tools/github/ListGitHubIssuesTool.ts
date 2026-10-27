import { PermissionLevel } from "@/types/permissions";
import type { LocalTool } from "@/types/tools";
import type { GitHubClient } from "@/github/GitHubClient";
import { validateGitHubRepoInput } from "@/tools/github/validateGitHubRepoInput";

export interface ListGitHubIssuesInput extends Record<string, unknown> {
  owner: string;
  repo: string;
  maxResults?: number;
}

/**
 * Lets Claude answer "any open issues on <repo>" / "what issues should I
 * know about". READ-level: purely informational, no side effects.
 */
export function createListGitHubIssuesTool(githubClient: GitHubClient): LocalTool<ListGitHubIssuesInput> {
  return {
    id: "LIST_GITHUB_ISSUES",
    name: "list_github_issues",
    description: "Lists currently open issues on a GitHub repository (pull requests excluded), most recently updated behavior left to GitHub's default order.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "The repository owner's GitHub username or organization name, e.g. \"davidpit1565\"." },
        repo: { type: "string", description: "The repository name, e.g. \"Jarvis\"." },
        maxResults: { type: "number", description: "Maximum number of issues to return. Defaults to 10, capped at 30." },
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
        const issues = await githubClient.listOpenIssues(validated.owner, validated.repo, validated.maxResults);
        return { success: true, data: { issues } };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
