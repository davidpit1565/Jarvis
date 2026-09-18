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

  test("clears a linked account and reports it was linked", async () => {
    const store = new CalendarTokenStore(":memory:");
    store.save({ refreshToken: "r1", accessToken: "a1", accessTokenExpiresAt: 123 });
    const tool = createUnlinkCalendarTool(store);

    const result = await tool.execute({}, context);

    expect(result.success).toBe(true);
    expect((result.data as { wasLinked: boolean }).wasLinked).toBe(true);
    expect(store.isLinked()).toBe(false);
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
});
