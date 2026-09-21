export type MemoryCategory = "fact" | "preference" | "commitment" | "temporary";

/** 1 (trivial) .. 5 (critical) — coarse enough to be useful without pretending to be a real ranking model. */
export type MemoryImportance = 1 | 2 | 3 | 4 | 5;

export interface MemoryRecord {
  id: string;
  key: string;
  value: string;
  createdAt: string;
  /** Defaults to "fact" for both new saves that don't specify one and pre-existing untyped rows. */
  category: MemoryCategory;
  /** Defaults to 3 ("normal") when not given explicitly. */
  importance: MemoryImportance;
  /** ISO timestamp this memory stops being "active" at, or null if it never expires. */
  expiresAt: string | null;
}

export interface SaveMemoryInput {
  key: string;
  value: string;
  category?: MemoryCategory;
  importance?: MemoryImportance;
  /**
   * Explicit expiry. When omitted and category is "temporary", MemoryStore
   * fills in a sensible default expiry itself rather than leaving a
   * "temporary" memory that in practice never expires.
   */
  expiresAt?: string | null;
}

/** One entry in a memory's change history — recorded whenever SAVE_MEMORY overwrites an existing value for the same key. */
export interface MemoryHistoryEntry {
  memoryKey: string;
  oldValue: string;
  newValue: string;
  changedAt: string;
}
