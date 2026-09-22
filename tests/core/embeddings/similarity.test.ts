import { describe, test, expect } from "bun:test";
import { cosineSimilarity } from "@/core/embeddings/similarity";

describe("cosineSimilarity", () => {
  test("identical vectors have similarity 1", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 10);
  });

  test("orthogonal vectors have similarity 0", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 10);
  });

  test("opposite vectors have similarity -1", () => {
    expect(cosineSimilarity([1, 2, 3], [-1, -2, -3])).toBeCloseTo(-1, 10);
  });

  test("scaling a vector doesn't change similarity (magnitude-invariant)", () => {
    const a = [1, 2, 3];
    const b = [2, 4, 6]; // same direction as a, scaled by 2
    expect(cosineSimilarity(a, b)).toBeCloseTo(1, 10);
  });

  test("a known non-trivial example matches the hand-computed value", () => {
    // a . b = 1*4 + 2*5 + 3*6 = 32; |a| = sqrt(14); |b| = sqrt(77)
    const a = [1, 2, 3];
    const b = [4, 5, 6];
    const expected = 32 / (Math.sqrt(14) * Math.sqrt(77));
    expect(cosineSimilarity(a, b)).toBeCloseTo(expected, 10);
  });

  test("a zero vector yields similarity 0 rather than NaN", () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
    expect(cosineSimilarity([1, 2, 3], [0, 0, 0])).toBe(0);
    expect(cosineSimilarity([0, 0], [0, 0])).toBe(0);
  });

  test("throws on mismatched vector lengths", () => {
    expect(() => cosineSimilarity([1, 2], [1, 2, 3])).toThrow();
  });

  test("negative and positive components both contribute correctly", () => {
    expect(cosineSimilarity([1, -1], [1, -1])).toBeCloseTo(1, 10);
    expect(cosineSimilarity([1, -1], [-1, 1])).toBeCloseTo(-1, 10);
  });
});
