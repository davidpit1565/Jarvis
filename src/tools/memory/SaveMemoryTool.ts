import { PermissionLevel } from "@/types/permissions";
import type { LocalTool } from "@/types/tools";
import type { MemoryStore } from "@/memory/MemoryStore";
import type { MemoryCategory, MemoryImportance, MemoryTrust } from "@/types/memory";
import type { EmbeddingsClientLike } from "@/tools/memory/SearchMemoryTool";

const MEMORY_CATEGORIES: MemoryCategory[] = ["fact", "preference", "commitment", "temporary"];
// EXTERNAL_CONTENT deliberately excluded from what the model may self-declare
// here: a write genuinely sourced from untrusted external content should
// come from ingestion code that sets it directly, not from the model
// asserting its own input is external content (which would be trivial for
// a malicious tool result to lie about either way, but there's no reason to
// hand the model that button at all — SYSTEM_DERIVED/MODEL_INFERRED/
// USER_STATED covers every legitimate case of Claude calling this tool).
const MEMORY_SOURCES: MemoryTrust[] = ["USER_STATED", "SYSTEM_DERIVED", "MODEL_INFERRED"];

export interface SaveMemoryInput extends Record<string, unknown> {
  key: string;
  value: string;
  /** Optional. Defaults to "fact" when omitted — existing callers that never pass this keep working unchanged. */
  category?: MemoryCategory;
  /** Optional 1-5 scale. Defaults to 3 ("normal") when omitted. */
  importance?: MemoryImportance;
  /** Optional ISO timestamp. A "temporary" memory saved with no explicit expiry gets a sensible default from MemoryStore. */
  expiresAt?: string | null;
  /** Optional provenance — see MemoryTrust. Defaults to "USER_STATED" when omitted. */
  source?: MemoryTrust;
}

/**
 * Lets Claude persist a fact about the user for recall in future
 * conversations. This is the concrete mechanism behind "JARVIS remembers
 * me" — without it, everything Claude learns is forgotten the moment the
 * conversation ends. SAFE_ACTION (not READ) because it mutates state;
 * granted to the local user by default in index.ts since this is a
 * single-user personal assistant, not a multi-tenant system.
 *
 * Semantic Memory Search (additive, opt-in): when `embeddingsClient` is
 * given (only true when OLLAMA_EMBEDDING_MODEL is configured — see
 * src/index.ts), this also computes and stores an embedding for the saved
 * value alongside it, so SEARCH_MEMORY can later find it semantically (see
 * SearchMemoryTool's own doc comment). Omitted (the default), or if Ollama
 * happens to be unreachable for this one call, the memory is still saved
 * normally — it just isn't semantically searchable until a future save
 * recomputes its embedding. An embedding failure NEVER fails the save
 * itself; SAVE_MEMORY's core job (persist the fact) always succeeds
 * regardless of Ollama's availability.
 */
export function createSaveMemoryTool(
  memoryStore: MemoryStore,
  embeddingsClient?: EmbeddingsClientLike
): LocalTool<SaveMemoryInput> {
  return {
    id: "SAVE_MEMORY",
    name: "save_memory",
    description:
      'Persists a fact about the user or their preferences so it can be recalled in future ' +
      'conversations. Use a short, descriptive key (e.g. "user.name", "user.timezone", ' +
      '"user.preference.editor") and the fact itself as the value. Only save things the user ' +
      "actually said or that are clearly and durably true — never guess or save transient details. " +
      'Set source to "USER_STATED" (the default) when the user said this themselves, or ' +
      '"MODEL_INFERRED" when you are saving it proactively from context without them stating it ' +
      "directly — this matters: a later USER_STATED correction can always overwrite a " +
      "MODEL_INFERRED guess, but a MODEL_INFERRED write can never silently overwrite an existing " +
      "USER_STATED fact for the same key (it will be rejected and flagged instead).",
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
        source: {
          type: "string",
          enum: MEMORY_SOURCES,
          description:
            'Optional. Where this value actually came from: "USER_STATED" (the user said it — default), ' +
            '"SYSTEM_DERIVED" (computed from a reliable internal source), or "MODEL_INFERRED" (your own ' +
            "proactive inference, not explicitly stated). Affects how future conflicting writes are resolved.",
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
      if (input.source !== undefined && !MEMORY_SOURCES.includes(input.source)) {
        return { success: false, error: `source must be one of: ${MEMORY_SOURCES.join(", ")}` };
      }
      if (input.expiresAt !== undefined && input.expiresAt !== null) {
        if (typeof input.expiresAt !== "string" || Number.isNaN(Date.parse(input.expiresAt))) {
          return { success: false, error: "expiresAt must be a valid ISO 8601 timestamp" };
        }
      }

      let embedding: number[] | undefined;
      if (embeddingsClient) {
        try {
          embedding = await embeddingsClient.embed(input.value);
        } catch {
          // Ollama unreachable/misconfigured for this one call — the save
          // itself must still succeed; it just won't be semantically
          // searchable until a later save recomputes the embedding.
        }
      }

      const record = memoryStore.save({
        key: input.key,
        value: input.value,
        category: input.category,
        importance: input.importance,
        expiresAt: input.expiresAt,
        source: input.source,
        embedding,
      });

      if (record.conflict) {
        return {
          success: true,
          data: {
            id: record.id,
            key: record.key,
            applied: false,
            reason:
              "This write was rejected: it conflicts with an existing, more-trusted memory for the same key. " +
              "The existing value was kept unchanged.",
          },
        };
      }
      return { success: true, data: { id: record.id, key: record.key, applied: true } };
    },
  };
}
