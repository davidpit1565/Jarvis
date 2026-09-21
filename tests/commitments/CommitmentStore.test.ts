import { describe, test, expect } from "bun:test";
import { CommitmentStore } from "@/commitments/CommitmentStore";

describe("CommitmentStore", () => {
  test("creates an open commitment with a loose dueContext", () => {
    const store = new CommitmentStore(":memory:");
    const record = store.create({ text: "Follow up about the invoice", dueContext: "tomorrow" });

    expect(record.text).toBe("Follow up about the invoice");
    expect(record.dueContext).toBe("tomorrow");
    expect(record.status).toBe("open");
    expect(record.fulfilledAt).toBeNull();
    store.close();
  });

  test("dueContext defaults to null when omitted", () => {
    const store = new CommitmentStore(":memory:");
    const record = store.create({ text: "Check on this" });

    expect(record.dueContext).toBeNull();
    store.close();
  });

  test("get returns null for an unknown id", () => {
    const store = new CommitmentStore(":memory:");
    expect(store.get("missing-id")).toBeNull();
    store.close();
  });

  test("get retrieves a created commitment by id", () => {
    const store = new CommitmentStore(":memory:");
    const record = store.create({ text: "Check on this", dueContext: "next week" });

    expect(store.get(record.id)?.text).toBe("Check on this");
    store.close();
  });

  test("list with no filter returns everything, newest first", () => {
    const store = new CommitmentStore(":memory:");
    const a = store.create({ text: "First" });
    const b = store.create({ text: "Second" });

    const all = store.list();
    expect(all.map((c) => c.id)).toEqual([b.id, a.id]);
    store.close();
  });

  test("list filters by status", () => {
    const store = new CommitmentStore(":memory:");
    const a = store.create({ text: "First" });
    const b = store.create({ text: "Second" });
    store.fulfill(a.id);

    expect(store.list("fulfilled").map((c) => c.id)).toEqual([a.id]);
    expect(store.list("open").map((c) => c.id)).toEqual([b.id]);
    store.close();
  });

  test("fulfill marks a commitment fulfilled and sets fulfilledAt", () => {
    const store = new CommitmentStore(":memory:");
    const record = store.create({ text: "Task" });

    const fulfilledAt = "2026-01-15T10:00:00.000Z";
    expect(store.fulfill(record.id, fulfilledAt)).toBe(true);

    const fetched = store.get(record.id);
    expect(fetched?.status).toBe("fulfilled");
    expect(fetched?.fulfilledAt).toBe(fulfilledAt);
    store.close();
  });

  test("fulfill returns false for an unknown id", () => {
    const store = new CommitmentStore(":memory:");
    expect(store.fulfill("missing-id")).toBe(false);
    store.close();
  });

  test("markStale transitions an open commitment to stale", () => {
    const store = new CommitmentStore(":memory:");
    const record = store.create({ text: "Task" });

    expect(store.markStale(record.id)).toBe(true);
    expect(store.get(record.id)?.status).toBe("stale");
    store.close();
  });

  test("markStale is a no-op on an already-fulfilled commitment", () => {
    const store = new CommitmentStore(":memory:");
    const record = store.create({ text: "Task" });
    store.fulfill(record.id);

    expect(store.markStale(record.id)).toBe(false);
    expect(store.get(record.id)?.status).toBe("fulfilled");
    store.close();
  });

  test("markStale is a no-op on an already-stale commitment (idempotent)", () => {
    const store = new CommitmentStore(":memory:");
    const record = store.create({ text: "Task" });
    store.markStale(record.id);

    expect(store.markStale(record.id)).toBe(false);
    store.close();
  });

  test("delete removes the commitment entirely", () => {
    const store = new CommitmentStore(":memory:");
    const record = store.create({ text: "Task" });

    expect(store.delete(record.id)).toBe(true);
    expect(store.get(record.id)).toBeNull();
    store.close();
  });

  test("delete returns false for an unknown id", () => {
    const store = new CommitmentStore(":memory:");
    expect(store.delete("missing-id")).toBe(false);
    store.close();
  });
});
