import { PermissionLevel } from "@/types/permissions";
import type { LocalTool } from "@/types/tools";
import type { GitHubClient } from "@/github/GitHubClient";
import { validateGitHubRepoInput } from "@/tools/github/validateGitHubRepoInput";

export interface ListGitHubPullRequestsInput extends Record<string, unknown> {
  owner: string;
  repo: string;
  maxResults?: number;
}

/**
 * Lets Claude answer "any open PRs on <repo>" / "what pull requests should
 * I know about". READ-level: purely informational, no side effects.
 */
export function createListGitHubPullRequestsTool(githubClient: GitHubClient): LocalTool<ListGitHubPullRequestsInput> {
  return {
    id: "LIST_GITHUB_PULL_REQUESTS",
    name: "list_github_pull_requests",
    description: "Lists currently open pull requests on a GitHub repository, including whether each is a draft.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "The repository owner's GitHub username or organization name, e.g. \"davidpit1565\"." },
        repo: { type: "string", description: "The repository name, e.g. \"Jarvis\"." },
        maxResults: { type: "number", description: "Maximum number of pull requests to return. Defaults to 10, capped at 30." },
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
        const pullRequests = await githubClient.listOpenPullRequests(validated.owner, validated.repo, validated.maxResults);
        return { success: true, data: { pullRequests } };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
