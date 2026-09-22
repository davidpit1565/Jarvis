/**
 * Dependency-free cosine similarity for two embedding vectors. This is the
 * entire "vector search" this codebase needs: JARVIS is a personal
 * assistant with dozens to low-thousands of memories/cached queries, not a
 * production vector database with millions of rows — a linear scan
 * computing cosine similarity in plain JS (see MemoryStore.searchSemantic
 * and ToolResultCache's semantic layer) is the right scale, and pulling in
 * an external vector-DB/ANN library here would be premature infrastructure
 * for a workload this small.
 *
 * Returns a value in [-1, 1] for two non-zero vectors of equal length
 * (1 = identical direction, 0 = orthogonal/unrelated, -1 = opposite). A
 * zero vector (all-zero embedding, which a real embedding model should
 * never actually produce, but which is easy to construct in a test) has no
 * defined direction to compare, so it's treated as similarity 0 to
 * everything rather than throwing or producing NaN/Infinity.
 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) {
    throw new Error(`cosineSimilarity: vectors must have the same length (got ${a.length} and ${b.length})`);
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }

  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
