import { describe, test, expect } from "bun:test";
import { CalendarTokenStore } from "@/calendar/CalendarTokenStore";
import { createListLinkedGoogleAccountsTool } from "@/tools/calendar/ListLinkedGoogleAccountsTool";
import { PermissionLevel } from "@/types/permissions";

const context = { userId: "user-1", requestId: "req-1" };

describe("LIST_LINKED_GOOGLE_ACCOUNTS tool", () => {
  test("is READ", () => {
    const store = new CalendarTokenStore(":memory:");
    const tool = createListLinkedGoogleAccountsTool(store);
    expect(tool.requiredPermission).toBe(PermissionLevel.READ);
    store.close();
  });

  test("returns an empty list when nothing is linked", async () => {
    const store = new CalendarTokenStore(":memory:");
    const tool = createListLinkedGoogleAccountsTool(store);

    const result = await tool.execute({}, context);

    expect(result.success).toBe(true);
    expect((result.data as { accounts: unknown[]; count: number }).accounts).toEqual([]);
    expect((result.data as { count: number }).count).toBe(0);
    store.close();
  });

  test("lists linked accounts oldest-first with email and linkedAt", async () => {
    const store = new CalendarTokenStore(":memory:");
    store.save("work@example.com", { refreshToken: "r1", accessToken: "a1", accessTokenExpiresAt: 123 });
    store.save("personal@example.com", { refreshToken: "r2", accessToken: "a2", accessTokenExpiresAt: 456 });
    const tool = createListLinkedGoogleAccountsTool(store);

    const result = await tool.execute({}, context);

    expect(result.success).toBe(true);
    const data = result.data as { accounts: Array<{ email: string; linkedAt: number }>; count: number };
    expect(data.count).toBe(2);
    expect(data.accounts.map((a) => a.email)).toEqual(["work@example.com", "personal@example.com"]);
    expect(typeof data.accounts[0]!.linkedAt).toBe("number");
    store.close();
  });

  test("has no side effects on the store", async () => {
    const store = new CalendarTokenStore(":memory:");
    store.save("me@example.com", { refreshToken: "r1", accessToken: "a1", accessTokenExpiresAt: 123 });
    const tool = createListLinkedGoogleAccountsTool(store);

    await tool.execute({}, context);

    expect(store.isLinked("me@example.com")).toBe(true);
    expect(store.count()).toBe(1);
    store.close();
  });
});
