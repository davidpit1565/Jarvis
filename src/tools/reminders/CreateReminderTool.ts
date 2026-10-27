import { PermissionLevel } from "@/types/permissions";
import type { LocalTool } from "@/types/tools";
import type { ReminderStore } from "@/reminders/ReminderStore";
import type { ReminderRecurrence, ReminderTone } from "@/types/reminders";
import { ANNOUNCE_TARGET_ALL } from "@/reminders/resolveAnnounceTargets";

export interface CreateReminderInput extends Record<string, unknown> {
  text: string;
  dueAt?: string;
  recurrence?: ReminderRecurrence;
  announce?: boolean;
  targetDevice?: string;
  tone?: ReminderTone;
}

const VALID_RECURRENCES: ReminderRecurrence[] = ["daily", "weekly"];
const VALID_TONES: ReminderTone[] = ["casual", "formal"];

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
      "automatically creates the next occurrence, advanced by one day/week. " +
      'For a reminder that should be SPOKEN OUT LOUD through a connected device rather than just pushed ' +
      'silently (e.g. "say this out loud on my Mac when it\'s due"), set "announce" to true; "targetDevice" ' +
      'picks which device ("all" for every connected device, a specific device id, or omit for "wherever ' +
      'available"), and "tone" tunes the phrasing ("casual" or "formal", defaults to casual).',
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
        announce: {
          type: "boolean",
          description:
            'When true, this reminder is spoken live through a connected device when due, instead of (in ' +
            "addition to) a silent push notification. Defaults to false.",
        },
        targetDevice: {
          type: "string",
          description:
            `Which device to speak an "announce" reminder through: "${ANNOUNCE_TARGET_ALL}" for every ` +
            'connected device, a specific device id, or omit for "wherever available" (the primary device if ' +
            "connected, else any connected device). Ignored unless announce is true.",
        },
        tone: {
          type: "string",
          enum: VALID_TONES,
          description:
            'Phrasing tone for an "announce" reminder\'s spoken text: "casual" (default) or "formal"/diplomatic.',
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
      if (input.announce !== undefined && typeof input.announce !== "boolean") {
        return { success: false, error: "announce must be a boolean" };
      }
      if (input.targetDevice !== undefined && (typeof input.targetDevice !== "string" || input.targetDevice.trim() === "")) {
        return { success: false, error: "targetDevice must be a non-empty string when provided" };
      }
      if (input.tone !== undefined && !VALID_TONES.includes(input.tone)) {
        return { success: false, error: `tone must be one of: ${VALID_TONES.join(", ")}` };
      }

      const record = reminderStore.create({
        text: input.text,
        dueAt: input.dueAt ?? null,
        recurrence: input.recurrence ?? null,
        announce: input.announce ?? false,
        targetDevice: input.targetDevice ?? null,
        tone: input.tone ?? null,
      });
      return {
        success: true,
        data: {
          id: record.id,
          text: record.text,
          dueAt: record.dueAt,
          recurrence: record.recurrence,
          announce: record.announce,
          targetDevice: record.targetDevice,
          tone: record.tone,
        },
      };
    },
  };
}
