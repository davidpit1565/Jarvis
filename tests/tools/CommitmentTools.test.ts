import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { CommitmentStore } from "@/commitments/CommitmentStore";
import { createCreateCommitmentTool } from "@/tools/commitments/CreateCommitmentTool";
import { createListCommitmentsTool } from "@/tools/commitments/ListCommitmentsTool";
import { createFulfillCommitmentTool } from "@/tools/commitments/FulfillCommitmentTool";
import { PermissionLevel } from "@/types/permissions";

const context = { userId: "user-1", requestId: "req-1" };

describe("CREATE_COMMITMENT tool", () => {
  let store: CommitmentStore;

  beforeEach(() => {
    store = new CommitmentStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  test("is a local tool requiring SAFE_ACTION", () => {
    const tool = createCreateCommitmentTool(store);
    expect(tool.target).toBe("local");
    expect(tool.requiredPermission).toBe(PermissionLevel.SAFE_ACTION);
    expect(tool.id).toBe("CREATE_COMMITMENT");
  });

  test("creates a commitment with a loose dueContext", async () => {
    const tool = createCreateCommitmentTool(store);
    const result = await tool.execute({ text: "Follow up about the invoice", dueContext: "tomorrow" }, context);

    expect(result.success).toBe(true);
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]?.dueContext).toBe("tomorrow");
  });

  test("creates a commitment with no dueContext", async () => {
    const tool = createCreateCommitmentTool(store);
    const result = await tool.execute({ text: "Check on this" }, context);

    expect(result.success).toBe(true);
    expect(store.list()[0]?.dueContext).toBeNull();
  });

  test("rejects an empty text", async () => {
    const tool = createCreateCommitmentTool(store);
    const result = await tool.execute({ text: "" }, context);
    expect(result.success).toBe(false);
  });

  test("rejects a non-string dueContext", async () => {
    const tool = createCreateCommitmentTool(store);
    const result = await tool.execute({ text: "Task", dueContext: 5 as never }, context);
    expect(result.success).toBe(false);
  });
});

describe("LIST_COMMITMENTS tool", () => {
  let store: CommitmentStore;

  beforeEach(() => {
    store = new CommitmentStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  test("is read-only", () => {
    const tool = createListCommitmentsTool(store);
    expect(tool.target).toBe("local");
    expect(tool.requiredPermission).toBe(PermissionLevel.READ);
  });

  test("lists all commitments by default", async () => {
    store.create({ text: "A" });
    store.create({ text: "B" });

    const tool = createListCommitmentsTool(store);
    const result = await tool.execute({}, context);

    expect(result.success).toBe(true);
    expect((result.data as { commitments: unknown[] }).commitments).toHaveLength(2);
  });

  test("filters by status", async () => {
    const a = store.create({ text: "A" });
    store.create({ text: "B" });
    store.fulfill(a.id);

    const tool = createListCommitmentsTool(store);
    const result = await tool.execute({ status: "fulfilled" }, context);

    expect((result.data as { commitments: unknown[] }).commitments).toHaveLength(1);
  });

  test("rejects an invalid status", async () => {
    const tool = createListCommitmentsTool(store);
    const result = await tool.execute({ status: "bogus" as never }, context);
    expect(result.success).toBe(false);
  });
});

describe("FULFILL_COMMITMENT tool", () => {
  let store: CommitmentStore;

  beforeEach(() => {
    store = new CommitmentStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  test("is a local tool requiring SAFE_ACTION", () => {
    const tool = createFulfillCommitmentTool(store);
    expect(tool.target).toBe("local");
    expect(tool.requiredPermission).toBe(PermissionLevel.SAFE_ACTION);
  });

  test("marks a commitment fulfilled", async () => {
    const record = store.create({ text: "Task" });
    const tool = createFulfillCommitmentTool(store);

    const result = await tool.execute({ id: record.id }, context);

    expect(result.success).toBe(true);
    expect(store.get(record.id)?.status).toBe("fulfilled");
  });

  test("fails for an unknown id", async () => {
    const tool = createFulfillCommitmentTool(store);
    const result = await tool.execute({ id: "missing" }, context);
    expect(result.success).toBe(false);
  });

  test("rejects an empty id", async () => {
    const tool = createFulfillCommitmentTool(store);
    const result = await tool.execute({ id: "" }, context);
    expect(result.success).toBe(false);
  });
});
