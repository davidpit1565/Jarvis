import { PermissionLevel } from "@/types/permissions";
import type { LocalTool } from "@/types/tools";
import type { MemoryStore } from "@/memory/MemoryStore";
import type { UndoStore } from "@/core/undo/UndoStore";

export interface DeleteMemoryInput extends Record<string, unknown> {
  key: string;
}

/**
 * Lets Claude actually forget a fact by key — without this, SAVE_MEMORY
 * could add or correct (see MemoryStore's upsert-by-key behavior) facts
 * but never remove one entirely, e.g. when the user says something is no
 * longer true and there's nothing to replace it with. SAFE_ACTION and
 * standing-granted for the same single-user reason as SAVE_MEMORY.
 *
 * When an `undoStore` is provided, fetches the fact's value before
 * deleting it and records it so "undo that" can restore it — same
 * fetch-then-act pattern as the other undoable delete tools.
 */
export function createDeleteMemoryTool(memoryStore: MemoryStore, undoStore?: UndoStore): LocalTool<DeleteMemoryInput> {
  return {
    id: "DELETE_MEMORY",
    name: "delete_memory",
    description:
      "Deletes a previously saved fact by its exact key (from a prior save_memory or search_memory call). " +
      "Use this when the user says something you remembered is no longer true and there's nothing to " +
      "replace it with — otherwise prefer save_memory with the same key to correct the value instead.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "The exact key of the fact to delete." },
      },
      required: ["key"],
    },
    requiredPermission: PermissionLevel.SAFE_ACTION,
    target: "local",

    async execute(input) {
      if (typeof input.key !== "string" || input.key.trim() === "") {
        return { success: false, error: "key must be a non-empty string" };
      }

      const factBeforeDelete = memoryStore.getByKey(input.key);
      const deleted = memoryStore.deleteByKey(input.key);
      if (!deleted) {
        return { success: false, error: `No saved fact found with key: ${input.key}` };
      }
      if (factBeforeDelete) {
        undoStore?.record({
          type: "memory_deleted",
          key: factBeforeDelete.key,
          value: factBeforeDelete.value,
          category: factBeforeDelete.category,
          importance: factBeforeDelete.importance,
          expiresAt: factBeforeDelete.expiresAt,
          source: factBeforeDelete.source,
        });
      }
      return { success: true, data: { key: input.key } };
    },
  };
}
