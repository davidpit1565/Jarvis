import { describe, test, expect } from "bun:test";
import { MemoryStore } from "@/memory/MemoryStore";

describe("MemoryStore", () => {
  test("saves and retrieves a record", () => {
    const store = new MemoryStore(":memory:");
    const record = store.save({ key: "greeting", value: "hello" });

    const fetched = store.get(record.id);
    expect(fetched?.value).toBe("hello");
    store.close();
  });

  test("returns null for an unknown id", () => {
    const store = new MemoryStore(":memory:");
    expect(store.get("missing-id")).toBeNull();
    store.close();
  });

  test("searches records by key fragment", () => {
    const store = new MemoryStore(":memory:");
    store.save({ key: "user.name", value: "David" });
    store.save({ key: "user.email", value: "dp@example.com" });
    store.save({ key: "device.mac", value: "MacBook" });

    const results = store.search("user.");
    expect(results).toHaveLength(2);
    store.close();
  });

  test("deletes a record", () => {
    const store = new MemoryStore(":memory:");
    const record = store.save({ key: "temp", value: "value" });

    expect(store.delete(record.id)).toBe(true);
    expect(store.get(record.id)).toBeNull();
    store.close();
  });

  test("delete returns false for unknown id", () => {
    const store = new MemoryStore(":memory:");
    expect(store.delete("missing-id")).toBe(false);
    store.close();
  });
});
