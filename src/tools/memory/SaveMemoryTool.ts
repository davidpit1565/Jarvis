import { PermissionLevel } from "@/types/permissions";
import type { LocalTool } from "@/types/tools";
import type { MemoryStore } from "@/memory/MemoryStore";
import type { MemoryCategory, MemoryImportance } from "@/types/memory";

const MEMORY_CATEGORIES: MemoryCategory[] = ["fact", "preference", "commitment", "temporary"];

export interface SaveMemoryInput extends Record<string, unknown> {
  key: string;
  value: string;
  /** Optional. Defaults to "fact" when omitted — existing callers that never pass this keep working unchanged. */
  category?: MemoryCategory;
  /** Optional 1-5 scale. Defaults to 3 ("normal") when omitted. */
  importance?: MemoryImportance;
  /** Optional ISO timestamp. A "temporary" memory saved with no explicit expiry gets a sensible default from MemoryStore. */
  expiresAt?: string | null;
}

/**
 * Lets Claude persist a fact about the user for recall in future
 * conversations. This is the concrete mechanism behind "JARVIS remembers
 * me" — without it, everything Claude learns is forgotten the moment the
 * conversation ends. SAFE_ACTION (not READ) because it mutates state;
 * granted to the local user by default in index.ts since this is a
 * single-user personal assistant, not a multi-tenant system.
 */
export function createSaveMemoryTool(memoryStore: MemoryStore): LocalTool<SaveMemoryInput> {
  return {
    id: "SAVE_MEMORY",
    name: "save_memory",
    description:
      'Persists a fact about the user or their preferences so it can be recalled in future ' +
      'conversations. Use a short, descriptive key (e.g. "user.name", "user.timezone", ' +
      '"user.preference.editor") and the fact itself as the value. Only save things the user ' +
      "actually said or that are clearly and durably true — never guess or save transient details.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: 'Short, descriptive key for this fact, e.g. "user.name".' },
        value: { type: "string", description: "The fact to remember, in plain text." },
        category: {
          type: "string",
          enum: MEMORY_CATEGORIES,
          description:
            'Optional. One of "fact", "preference", "commitment", or "temporary". Defaults to "fact" if omitted.',
        },
        importance: {
          type: "number",
          description: "Optional 1 (trivial) - 5 (critical) importance. Defaults to 3 if omitted.",
        },
        expiresAt: {
          type: "string",
          description:
            "Optional ISO timestamp this memory should stop being active at. Only meaningful for transient facts; leave unset for anything durable.",
        },
      },
      required: ["key", "value"],
    },
    requiredPermission: PermissionLevel.SAFE_ACTION,
    target: "local",

    async execute(input) {
      if (typeof input.key !== "string" || input.key.trim() === "") {
        return { success: false, error: "key must be a non-empty string" };
      }
      if (typeof input.value !== "string" || input.value.trim() === "") {
        return { success: false, error: "value must be a non-empty string" };
      }
      if (input.category !== undefined && !MEMORY_CATEGORIES.includes(input.category)) {
        return { success: false, error: `category must be one of: ${MEMORY_CATEGORIES.join(", ")}` };
      }
      if (
        input.importance !== undefined &&
        (typeof input.importance !== "number" || input.importance < 1 || input.importance > 5)
      ) {
        return { success: false, error: "importance must be a number between 1 and 5" };
      }

      const record = memoryStore.save({
        key: input.key,
        value: input.value,
        category: input.category,
        importance: input.importance,
        expiresAt: input.expiresAt,
      });
      return { success: true, data: { id: record.id, key: record.key } };
    },
  };
}
