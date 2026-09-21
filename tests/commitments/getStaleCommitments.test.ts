import { describe, test, expect } from "bun:test";
import { getStaleCommitments } from "@/commitments/getStaleCommitments";
import type { CommitmentRecord } from "@/types/commitments";

const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;

function makeCommitment(overrides: Partial<CommitmentRecord> = {}): CommitmentRecord {
  return {
    id: "commitment-1",
    text: "Follow up about the invoice",
    dueContext: "tomorrow",
    status: "open",
    createdAt: "2026-01-01T00:00:00.000Z",
    fulfilledAt: null,
    ...overrides,
  };
}

describe("getStaleCommitments", () => {
  test("includes an open commitment exactly at the threshold", () => {
    const commitment = makeCommitment({ createdAt: "2026-01-01T00:00:00.000Z" });
    const nowIso = "2026-01-04T00:00:00.000Z"; // exactly 3 days later
    expect(getStaleCommitments([commitment], THREE_DAYS_MS, nowIso)).toEqual([commitment]);
  });

  test("excludes an open commitment younger than the threshold", () => {
    const commitment = makeCommitment({ createdAt: "2026-01-01T00:00:00.000Z" });
    const nowIso = "2026-01-03T00:00:00.000Z"; // 2 days later
    expect(getStaleCommitments([commitment], THREE_DAYS_MS, nowIso)).toEqual([]);
  });

  test("excludes a fulfilled commitment even if old", () => {
    const commitment = makeCommitment({ createdAt: "2026-01-01T00:00:00.000Z", status: "fulfilled" });
    const nowIso = "2026-02-01T00:00:00.000Z";
    expect(getStaleCommitments([commitment], THREE_DAYS_MS, nowIso)).toEqual([]);
  });

  test("excludes a commitment already marked stale", () => {
    const commitment = makeCommitment({ createdAt: "2026-01-01T00:00:00.000Z", status: "stale" });
    const nowIso = "2026-02-01T00:00:00.000Z";
    expect(getStaleCommitments([commitment], THREE_DAYS_MS, nowIso)).toEqual([]);
  });

  test("excludes a commitment whose id is in excludeIds, even though it's otherwise stale", () => {
    const commitment = makeCommitment({ id: "in-flight", createdAt: "2026-01-01T00:00:00.000Z" });
    const nowIso = "2026-02-01T00:00:00.000Z";
    const stale = getStaleCommitments([commitment], THREE_DAYS_MS, nowIso, new Set(["in-flight"]));
    expect(stale).toEqual([]);
  });

  test("still includes a stale commitment whose id isn't in excludeIds", () => {
    const commitment = makeCommitment({ id: "commitment-2", createdAt: "2026-01-01T00:00:00.000Z" });
    const nowIso = "2026-02-01T00:00:00.000Z";
    const stale = getStaleCommitments([commitment], THREE_DAYS_MS, nowIso, new Set(["some-other-id"]));
    expect(stale).toEqual([commitment]);
  });
});
