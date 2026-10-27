import { PermissionLevel } from "@/types/permissions";
import type { LocalTool } from "@/types/tools";
import type { GitHubClient } from "@/github/GitHubClient";
import { validateGitHubRepoInput } from "@/tools/github/validateGitHubRepoInput";

export interface ListGitHubCommitsInput extends Record<string, unknown> {
  owner: string;
  repo: string;
  branch?: string;
  maxResults?: number;
}

/**
 * Lets Claude answer "what did I push recently" / "what's the latest commit
 * on <repo>" — recent commits on a repo's branch, most recent first.
 * READ-level: purely informational, no side effects.
 */
export function createListGitHubCommitsTool(githubClient: GitHubClient): LocalTool<ListGitHubCommitsInput> {
  return {
    id: "LIST_GITHUB_COMMITS",
    name: "list_github_commits",
    description:
      "Lists the most recent commits on a GitHub repository's branch (defaults to the repo's default branch), most recent first. " +
      "Use this for \"what did I push recently\" / \"what's the latest commit on <repo>\" style questions.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "The repository owner's GitHub username or organization name, e.g. \"davidpit1565\"." },
        repo: { type: "string", description: "The repository name, e.g. \"Jarvis\"." },
        branch: { type: "string", description: "Branch/ref to list commits on. Defaults to the repo's default branch." },
        maxResults: { type: "number", description: "Maximum number of commits to return. Defaults to 10, capped at 30." },
      },
      required: ["owner", "repo"],
    },
    requiredPermission: PermissionLevel.READ,
    target: "local",
    semanticCacheable: false,

    async execute(input) {
      const validated = validateGitHubRepoInput(input);
      if (!validated.valid) {
        return { success: false, error: validated.reason };
      }

      try {
        const commits = await githubClient.listRecentCommits(validated.owner, validated.repo, validated.branch, validated.maxResults);
        return { success: true, data: { commits } };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
