import { PermissionLevel } from "@/types/permissions";
import type { LocalTool } from "@/types/tools";
import type { ReminderStore } from "@/reminders/ReminderStore";
import type { ReminderRecurrence } from "@/types/reminders";

export interface CreateReminderInput extends Record<string, unknown> {
  text: string;
  dueAt?: string;
  recurrence?: ReminderRecurrence;
}

const VALID_RECURRENCES: ReminderRecurrence[] = ["daily", "weekly"];

function isValidIsoDate(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}

// The model resolves phrases like "tomorrow morning" into an absolute
// timestamp itself; a date-math slip (wrong day, AM/PM, timezone, year)
// would otherwise silently create a reminder that's already overdue the
// moment it's created. A small grace period avoids rejecting a
// legitimate "remind me right now" due to processing lag between the
// model resolving "now" and this call actually running.
const PAST_DUE_AT_GRACE_MS = 60_000;

function isTooFarInThePast(isoDate: string): boolean {
  return Date.parse(isoDate) < Date.now() - PAST_DUE_AT_GRACE_MS;
}

/**
 * Lets Claude create a reminder/task — the concrete mechanism behind "JARVIS,
 * remind me to..." A reminder is deliberately distinct from a memory: it has
 * a lifecycle (pending -> completed), not just a fact to recall. SAFE_ACTION
 * and standing-granted like SAVE_MEMORY, for the same single-user reason.
 */
export function createCreateReminderTool(reminderStore: ReminderStore): LocalTool<CreateReminderInput> {
  return {
    id: "CREATE_REMINDER",
    name: "create_reminder",
    description:
      "Creates a reminder or task for the user to see later. Use plain, specific text for what needs " +
      'to be done. If the user gave a specific time or date, pass it as an ISO 8601 timestamp in "dueAt" ' +
      "(e.g. from a phrase like \"remind me at 6pm\" or \"tomorrow morning\", resolve it to an actual " +
      'timestamp yourself); omit "dueAt" entirely for an undated task. For a repeating reminder (e.g. ' +
      '"remind me every day to take my medication"), pass "recurrence" and a "dueAt" — completing it then ' +
      "automatically creates the next occurrence, advanced by one day/week.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "What the reminder/task is, in plain text." },
        dueAt: { type: "string", description: "ISO 8601 timestamp this is due at. Omit for an undated task." },
        recurrence: {
          type: "string",
          enum: VALID_RECURRENCES,
          description: 'For a repeating reminder: "daily" or "weekly". Requires dueAt. Omit for a one-off reminder.',
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
      if (input.dueAt !== undefined) {
        if (typeof input.dueAt !== "string" || !isValidIsoDate(input.dueAt)) {
          return { success: false, error: "dueAt must be a valid ISO 8601 timestamp" };
        }
        if (isTooFarInThePast(input.dueAt)) {
          return { success: false, error: "dueAt must not be in the past — resolve relative phrases to the actual future date" };
        }
      }
      if (input.recurrence !== undefined) {
        if (!VALID_RECURRENCES.includes(input.recurrence)) {
          return { success: false, error: `recurrence must be one of: ${VALID_RECURRENCES.join(", ")}` };
        }
        if (input.dueAt === undefined) {
          return { success: false, error: "recurrence requires dueAt" };
        }
      }

      const record = reminderStore.create({
        text: input.text,
        dueAt: input.dueAt ?? null,
        recurrence: input.recurrence ?? null,
      });
      return {
        success: true,
        data: { id: record.id, text: record.text, dueAt: record.dueAt, recurrence: record.recurrence },
      };
    },
  };
}
