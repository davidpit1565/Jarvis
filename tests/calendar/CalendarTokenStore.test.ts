import { describe, test, expect } from "bun:test";
import { CalendarTokenStore } from "@/calendar/CalendarTokenStore";

describe("CalendarTokenStore", () => {
  test("returns null and reports unlinked when nothing is saved", () => {
    const store = new CalendarTokenStore(":memory:");
    expect(store.get()).toBeNull();
    expect(store.isLinked()).toBe(false);
    store.close();
  });

  test("saves and retrieves tokens", () => {
    const store = new CalendarTokenStore(":memory:");
    store.save({ refreshToken: "refresh-1", accessToken: "access-1", accessTokenExpiresAt: 12345 });

    expect(store.isLinked()).toBe(true);
    expect(store.get()).toEqual({ refreshToken: "refresh-1", accessToken: "access-1", accessTokenExpiresAt: 12345 });
    store.close();
  });

  test("save replaces a previously saved token set (re-linking)", () => {
    const store = new CalendarTokenStore(":memory:");
    store.save({ refreshToken: "refresh-1", accessToken: "access-1", accessTokenExpiresAt: 111 });
    store.save({ refreshToken: "refresh-2", accessToken: "access-2", accessTokenExpiresAt: 222 });

    expect(store.get()?.refreshToken).toBe("refresh-2");
    store.close();
  });

  test("updateAccessToken leaves the refresh token untouched", () => {
    const store = new CalendarTokenStore(":memory:");
    store.save({ refreshToken: "refresh-1", accessToken: "access-1", accessTokenExpiresAt: 111 });
    store.updateAccessToken("access-2", 999);

    expect(store.get()).toEqual({ refreshToken: "refresh-1", accessToken: "access-2", accessTokenExpiresAt: 999 });
    store.close();
  });

  test("clear unlinks the account", () => {
    const store = new CalendarTokenStore(":memory:");
    store.save({ refreshToken: "refresh-1", accessToken: "access-1", accessTokenExpiresAt: 111 });
    store.clear();

    expect(store.isLinked()).toBe(false);
    store.close();
  });

  test("survives across instances backed by the same SQLite file", () => {
    const dbPath = `/tmp/jarvis-calendar-token-test-${crypto.randomUUID()}.sqlite`;

    const first = new CalendarTokenStore(dbPath);
    first.save({ refreshToken: "refresh-1", accessToken: "access-1", accessTokenExpiresAt: 111 });
    first.close();

    const second = new CalendarTokenStore(dbPath);
    expect(second.get()?.refreshToken).toBe("refresh-1");
    second.close();
  });
});
