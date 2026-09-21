import { PermissionLevel } from "@/types/permissions";
import type { LocalTool } from "@/types/tools";
import type { CommitmentStore } from "@/commitments/CommitmentStore";

export interface CreateCommitmentInput extends Record<string, unknown> {
  text: string;
  dueContext?: string;
}

/**
 * Lets Claude record a commitment/promise — the concrete mechanism behind
 * "I'll follow up with you tomorrow" or "remind me to check on this next
 * week" said mid-conversation. Deliberately distinct from CREATE_REMINDER:
 * a commitment has a loose `dueContext` ("tomorrow", "next week"), not a
 * precise `dueAt` — use create_reminder instead when the user gives (or
 * you can resolve) an actual time. SAFE_ACTION and standing-granted, same
 * reasoning as CREATE_REMINDER: this is a single-user assistant recording
 * its own follow-up intentions, not a multi-tenant action needing
 * per-call approval.
 */
export function createCreateCommitmentTool(commitmentStore: CommitmentStore): LocalTool<CreateCommitmentInput> {
  return {
    id: "CREATE_COMMITMENT",
    name: "create_commitment",
    description:
      "Records a commitment/promise — something JARVIS or the user said would happen, distinct from a " +
      'formal reminder. Use this when you say things like "I\'ll follow up with you tomorrow" or the user ' +
      'says "remind me to check on this next week" without a precise time. Pass a loose "dueContext" ' +
      '(e.g. "tomorrow", "next week", "after the meeting") if one was mentioned — if the user gave an ' +
      "exact time instead, use create_reminder, not this tool.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "What was committed to, in plain text." },
        dueContext: {
          type: "string",
          description: 'A loose description of when this is expected, e.g. "tomorrow" or "next week". Omit if unspecified.',
        },
      },
      required: ["text"],
    },
    requiredPermission: PermissionLevel.SAFE_ACTION,
    target: "local",

    async execute(input) {
      if (typeof input.text !== "string" || input.text.trim() === "") {
        return { success: false, error: "text must be a non-empty string" };
      }
      if (input.dueContext !== undefined && typeof input.dueContext !== "string") {
        return { success: false, error: "dueContext must be a string" };
      }

      const record = commitmentStore.create({ text: input.text, dueContext: input.dueContext ?? null });
      return {
        success: true,
        data: { id: record.id, text: record.text, dueContext: record.dueContext, status: record.status },
      };
    },
  };
}
