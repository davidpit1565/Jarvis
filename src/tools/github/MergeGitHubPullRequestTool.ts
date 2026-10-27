import { PermissionLevel } from "@/types/permissions";
import type { LocalTool } from "@/types/tools";
import type { GitHubClient } from "@/github/GitHubClient";
import { validateGitHubRepoInput, validateIssueOrPullNumber, validateMergeOptions } from "@/tools/github/validateGitHubRepoInput";

export interface MergeGitHubPullRequestInput extends Record<string, unknown> {
  owner: string;
  repo: string;
  pullNumber: number;
  mergeMethod?: "merge" | "squash" | "rebase";
  commitTitle?: string;
  commitMessage?: string;
}

/**
 * Merges a pull request into its base branch.
 *
 * DANGEROUS-tier, not just CONFIRM — deliberately tiered higher than
 * COMMENT_ON_GITHUB_ISSUE. Reasoning (see the PR description for the full
 * writeup): a merge changes a real repository's permanent history, can
 * trigger downstream CI/CD/deployments outside JARVIS's own control, and
 * — like PUBLISH_REEL (also DANGEROUS, for the same "real, public,
 * practically-irreversible action" shape) — undoing it is a real,
 * disruptive operation (a revert PR/commit), not a clean undo the way
 * unlinking an OAuth connection is. This matches how this codebase already
 * tiers comparably consequential-but-common actions: EMPTY_TRASH is
 * CONFIRM because it's reversible in spirit but still worth asking about;
 * PUBLISH_REEL is DANGEROUS because the action is public and structurally
 * hard to walk back. A PR merge sits with PUBLISH_REEL, not EMPTY_TRASH.
 *
 * GitHub's own merge endpoint still refuses (never silently force-passes)
 * a PR blocked by required checks or branch protection — see
 * GitHubClient.mergePullRequest's own doc comment for the exact status
 * codes this surfaces as real tool failures.
 */
export function createMergeGitHubPullRequestTool(githubClient: GitHubClient): LocalTool<MergeGitHubPullRequestInput> {
  return {
    id: "MERGE_GITHUB_PULL_REQUEST",
    name: "merge_github_pull_request",
    description:
      "Merges an open pull request into its base branch — a real, permanent, practically-irreversible change to the " +
      "repository's history that can trigger downstream CI/deployments. GitHub will refuse the merge (not silently " +
      "force it) if required checks haven't passed or the PR has conflicts. Defaults to GitHub's own default merge " +
      "commit behavior if mergeMethod/commitTitle/commitMessage are omitted.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "The repository owner's GitHub username or organization name, e.g. \"davidpit1565\"." },
        repo: { type: "string", description: "The repository name, e.g. \"Jarvis\"." },
        pullNumber: { type: "number", description: "The pull request number to merge." },
        mergeMethod: { type: "string", enum: ["merge", "squash", "rebase"], description: "Merge strategy. Defaults to GitHub's own default (a merge commit) if omitted." },
        commitTitle: { type: "string", description: "Title for the merge commit. Omit to use GitHub's own auto-generated title." },
        commitMessage: { type: "string", description: "Extra detail appended to the merge commit message. Omit to use GitHub's own default." },
      },
      required: ["owner", "repo", "pullNumber"],
    },
    requiredPermission: PermissionLevel.DANGEROUS,
    target: "local",

    async execute(input) {
      const repoValidated = validateGitHubRepoInput(input);
      if (!repoValidated.valid) {
        return { success: false, error: repoValidated.reason };
      }
      const numberValidated = validateIssueOrPullNumber(input.pullNumber);
      if (!numberValidated.valid) {
        return { success: false, error: numberValidated.reason };
      }
      const optionsValidated = validateMergeOptions(input);
      if (!optionsValidated.valid) {
        return { success: false, error: optionsValidated.reason };
      }

      try {
        const result = await githubClient.mergePullRequest(repoValidated.owner, repoValidated.repo, numberValidated.value, {
          mergeMethod: optionsValidated.mergeMethod,
          commitTitle: optionsValidated.commitTitle,
          commitMessage: optionsValidated.commitMessage,
        });
        return { success: true, data: result };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
