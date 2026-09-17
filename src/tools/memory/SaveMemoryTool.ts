import { PermissionLevel } from "@/types/permissions";
import type { LocalTool } from "@/types/tools";
import type { MemoryStore } from "@/memory/MemoryStore";

export interface SaveMemoryInput extends Record<string, unknown> {
  key: string;
  value: string;
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

      const record = memoryStore.save({ key: input.key, value: input.value });
      return { success: true, data: { id: record.id, key: record.key } };
    },
  };
}
