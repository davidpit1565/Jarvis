import { describe, test, expect } from "bun:test";
import { CalendarTokenStore } from "@/calendar/CalendarTokenStore";
import { createUnlinkCalendarTool } from "@/tools/calendar/UnlinkCalendarTool";
import { PermissionLevel } from "@/types/permissions";

const context = { userId: "user-1", requestId: "req-1" };

describe("UNLINK_CALENDAR tool", () => {
  test("is DANGEROUS", () => {
    const store = new CalendarTokenStore(":memory:");
    const tool = createUnlinkCalendarTool(store);
    expect(tool.requiredPermission).toBe(PermissionLevel.DANGEROUS);
    store.close();
  });

  test("with exactly one account linked and no account given, unlinks it without asking", async () => {
    const store = new CalendarTokenStore(":memory:");
    store.save("me@example.com", { refreshToken: "r1", accessToken: "a1", accessTokenExpiresAt: 123 });
    const tool = createUnlinkCalendarTool(store);

    const result = await tool.execute({}, context);

    expect(result.success).toBe(true);
    expect((result.data as { wasLinked: boolean; account: string }).wasLinked).toBe(true);
    expect((result.data as { wasLinked: boolean; account: string }).account).toBe("me@example.com");
    expect(store.isLinked("me@example.com")).toBe(false);
    store.close();
  });

  test("succeeds with wasLinked: false when nothing was linked", async () => {
    const store = new CalendarTokenStore(":memory:");
    const tool = createUnlinkCalendarTool(store);

    const result = await tool.execute({}, context);

    expect(result.success).toBe(true);
    expect((result.data as { wasLinked: boolean }).wasLinked).toBe(false);
    store.close();
  });

  test("unlinks a specific account by email, leaving other linked accounts untouched", async () => {
    const store = new CalendarTokenStore(":memory:");
    store.save("work@example.com", { refreshToken: "r1", accessToken: "a1", accessTokenExpiresAt: 123 });
    store.save("personal@example.com", { refreshToken: "r2", accessToken: "a2", accessTokenExpiresAt: 456 });
    const tool = createUnlinkCalendarTool(store);

    const result = await tool.execute({ account: "work@example.com" }, context);

    expect(result.success).toBe(true);
    expect((result.data as { wasLinked: boolean }).wasLinked).toBe(true);
    expect(store.isLinked("work@example.com")).toBe(false);
    expect(store.isLinked("personal@example.com")).toBe(true);
    store.close();
  });

  test("with more than one account linked and no account given, refuses and lists the linked accounts instead of guessing", async () => {
    const store = new CalendarTokenStore(":memory:");
    store.save("work@example.com", { refreshToken: "r1", accessToken: "a1", accessTokenExpiresAt: 123 });
    store.save("personal@example.com", { refreshToken: "r2", accessToken: "a2", accessTokenExpiresAt: 456 });
    const tool = createUnlinkCalendarTool(store);

    const result = await tool.execute({}, context);

    expect(result.success).toBe(false);
    expect(result.error).toContain("work@example.com");
    expect(result.error).toContain("personal@example.com");
    expect((result.data as { linkedAccounts: string[] }).linkedAccounts).toEqual(["work@example.com", "personal@example.com"]);
    // Neither account was touched.
    expect(store.isLinked("work@example.com")).toBe(true);
    expect(store.isLinked("personal@example.com")).toBe(true);
    store.close();
  });

  test("unlinking an account that isn't linked reports wasLinked: false without throwing", async () => {
    const store = new CalendarTokenStore(":memory:");
    const tool = createUnlinkCalendarTool(store);

    const result = await tool.execute({ account: "nobody@example.com" }, context);

    expect(result.success).toBe(true);
    expect((result.data as { wasLinked: boolean }).wasLinked).toBe(false);
    store.close();
  });
});
