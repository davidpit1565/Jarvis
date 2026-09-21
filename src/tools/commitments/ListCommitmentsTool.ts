import { PermissionLevel } from "@/types/permissions";
import type { LocalTool } from "@/types/tools";
import type { CommitmentStore } from "@/commitments/CommitmentStore";
import type { CommitmentStatus } from "@/types/commitments";

export interface ListCommitmentsInput extends Record<string, unknown> {
  status?: CommitmentStatus;
}

const VALID_STATUSES: CommitmentStatus[] = ["open", "fulfilled", "stale"];

/**
 * Lets Claude answer "what did I say I'd follow up on" with the user's
 * actual recorded commitments. READ-level, same reasoning as
 * LIST_REMINDERS: this only ever reads state.
 */
export function createListCommitmentsTool(commitmentStore: CommitmentStore): LocalTool<ListCommitmentsInput> {
  return {
    id: "LIST_COMMITMENTS",
    name: "list_commitments",
    description:
      'Lists recorded commitments/promises, newest first. Pass "status" to filter to just "open", ' +
      '"fulfilled", or "stale" ones; omit it to see all.',
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: VALID_STATUSES, description: "Filter to one status. Omit to see all." },
      },
    },
    requiredPermission: PermissionLevel.READ,
    target: "local",

    async execute(input) {
      if (input.status !== undefined && !VALID_STATUSES.includes(input.status)) {
        return { success: false, error: `status must be one of: ${VALID_STATUSES.join(", ")}` };
      }
      const commitments = commitmentStore.list(input.status);
      return { success: true, data: { commitments } };
    },
  };
}
