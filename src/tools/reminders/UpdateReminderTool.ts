import { PermissionLevel } from "@/types/permissions";
import type { LocalTool } from "@/types/tools";
import type { ReminderStore } from "@/reminders/ReminderStore";
import type { ReminderRecurrence } from "@/types/reminders";

export interface UpdateReminderInput extends Record<string, unknown> {
  id: string;
  text?: string;
  dueAt?: string | null;
  recurrence?: ReminderRecurrence | null;
}

const VALID_RECURRENCES: ReminderRecurrence[] = ["daily", "weekly"];

function isValidIsoDate(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}

// Same reasoning as CreateReminderTool: a date-math slip when resolving
// a relative phrase would otherwise silently move a reminder to a time
// that's already past. Small grace period for processing lag.
const PAST_DUE_AT_GRACE_MS = 60_000;

function isTooFarInThePast(isoDate: string): boolean {
  return Date.parse(isoDate) < Date.now() - PAST_DUE_AT_GRACE_MS;
}

/**
 * Edits an existing reminder's text and/or due date in place — e.g.
 * "actually make that 7pm instead" or fixing a typo. Without this, the
 * only way to change anything about a reminder was delete-then-recreate,
 * which loses its original id and createdAt for no reason.
 */
export function createUpdateReminderTool(reminderStore: ReminderStore): LocalTool<UpdateReminderInput> {
  return {
    id: "UPDATE_REMINDER",
    name: "update_reminder",
    description:
      "Edits an existing reminder/task's text, due date, and/or recurrence, given its id. Omit a field to " +
      'leave it unchanged; pass dueAt or recurrence as null to clear it. Use this for "actually make that ' +
      '7pm instead" / "change that reminder to..." / "stop that reminder from repeating" rather than ' +
      "deleting and recreating it.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The reminder's id." },
        text: { type: "string", description: "New text. Omit to leave unchanged." },
        dueAt: {
          type: ["string", "null"],
          description: "New ISO 8601 due timestamp, or null to clear it. Omit to leave unchanged.",
        },
        recurrence: {
          type: ["string", "null"],
          enum: [...VALID_RECURRENCES, null],
          description: 'New recurrence ("daily"/"weekly"), or null to make it a one-off. Omit to leave unchanged.',
        },
      },
      required: ["id"],
    },
    requiredPermission: PermissionLevel.SAFE_ACTION,
    target: "local",

    async execute(input) {
      if (typeof input.id !== "string" || input.id.trim() === "") {
        return { success: false, error: "id must be a non-empty string" };
      }
      if (input.text !== undefined && (typeof input.text !== "string" || input.text.trim() === "")) {
        return { success: false, error: "text must be a non-empty string when provided" };
      }
      if (input.dueAt !== undefined && input.dueAt !== null) {
        if (typeof input.dueAt !== "string" || !isValidIsoDate(input.dueAt)) {
          return { success: false, error: "dueAt must be a valid ISO 8601 timestamp, or null" };
        }
        if (isTooFarInThePast(input.dueAt)) {
          return { success: false, error: "dueAt must not be in the past — resolve relative phrases to the actual future date" };
        }
      }
      if (input.recurrence !== undefined && input.recurrence !== null && !VALID_RECURRENCES.includes(input.recurrence)) {
        return { success: false, error: `recurrence must be one of: ${VALID_RECURRENCES.join(", ")}, or null` };
      }

      // Same invariant CreateReminderTool enforces at creation time: a
      // recurring reminder needs a dueAt to recur from — without this,
      // an update could leave (or put) a reminder in a recurrence-set/
      // dueAt-null state that CreateReminderTool would have refused
      // outright. ReminderStore.complete() silently treats that
      // combination as a one-off (its `existing.recurrence &&
      // existing.dueAt` guard), so the reminder would just stop
      // recurring with no error and no next occurrence, even though its
      // own `recurrence` field still claims otherwise.
      if (input.dueAt !== undefined || input.recurrence !== undefined) {
        const existing = reminderStore.get(input.id);
        if (existing) {
          const resultingDueAt = input.dueAt !== undefined ? input.dueAt : existing.dueAt;
          const resultingRecurrence = input.recurrence !== undefined ? input.recurrence : existing.recurrence;
          if (resultingRecurrence && !resultingDueAt) {
            return { success: false, error: "recurrence requires dueAt" };
          }
        }
      }

      const updated = reminderStore.update(input.id, {
        text: input.text,
        dueAt: input.dueAt,
        recurrence: input.recurrence,
      });
      if (!updated) {
        return { success: false, error: `No reminder found with id: ${input.id}` };
      }
      return {
        success: true,
        data: { id: updated.id, text: updated.text, dueAt: updated.dueAt, recurrence: updated.recurrence },
      };
    },
  };
}
