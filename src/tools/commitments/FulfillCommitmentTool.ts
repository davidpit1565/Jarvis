import { PermissionLevel } from "@/types/permissions";
import type { LocalTool } from "@/types/tools";
import type { CommitmentStore } from "@/commitments/CommitmentStore";

export interface FulfillCommitmentInput extends Record<string, unknown> {
  id: string;
}

/**
 * Lets Claude mark a commitment fulfilled — "I already followed up on
 * that" should actually clear it, the same role COMPLETE_REMINDER plays
 * for reminders. SAFE_ACTION and standing-granted for the same
 * single-user reason as CREATE_COMMITMENT.
 */
export function createFulfillCommitmentTool(commitmentStore: CommitmentStore): LocalTool<FulfillCommitmentInput> {
  return {
    id: "FULFILL_COMMITMENT",
    name: "fulfill_commitment",
    description:
      "Marks a commitment/promise as fulfilled, given its id (from a prior list_commitments or " +
      "create_commitment call).",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The commitment's id." },
      },
      required: ["id"],
    },
    requiredPermission: PermissionLevel.SAFE_ACTION,
    target: "local",

    async execute(input) {
      if (typeof input.id !== "string" || input.id.trim() === "") {
        return { success: false, error: "id must be a non-empty string" };
      }

      const fulfilled = commitmentStore.fulfill(input.id);
      if (!fulfilled) {
        return { success: false, error: `No commitment found with id: ${input.id}` };
      }
      return { success: true, data: { id: input.id } };
    },
  };
}
