import { describe, test, expect } from "bun:test";
import { ReminderStore } from "@/reminders/ReminderStore";
import { composeAnnouncementText } from "@/reminders/composeAnnouncementText";
import { getAnnounceFollowUps, MAX_ANNOUNCE_FOLLOW_UPS, ANNOUNCE_FOLLOW_UP_INTERVAL_MS } from "@/reminders/getAnnounceFollowUps";
import { resolveAnnounceTargets, ANNOUNCE_TARGET_ALL } from "@/reminders/resolveAnnounceTargets";
import type { DeviceRegistry } from "@/devices/registry/DeviceRegistry";
import type { DeviceConnectionManager } from "@/communication/websocket/DeviceConnectionManager";
import type { ReminderRecord } from "@/types/reminders";

function makeReminder(overrides: Partial<ReminderRecord> = {}): ReminderRecord {
  return {
    id: "r1",
    text: "Take medication",
    dueAt: "2026-01-15T08:00:00.000Z",
    completed: false,
    createdAt: "2026-01-15T07:00:00.000Z",
    recurrence: null,
    notifiedAt: "2026-01-15T08:00:05.000Z",
    announce: true,
    targetDevice: null,
    tone: null,
    acknowledgedAt: null,
    followUpCount: 0,
    lastFollowUpAt: null,
    ...overrides,
  };
}

describe("ReminderStore announce fields", () => {
  test("defaults announce/targetDevice/tone/acknowledgedAt/followUpCount for a plain reminder", () => {
    const store = new ReminderStore(":memory:");
    const record = store.create({ text: "Pick up dry cleaning" });

    expect(record.announce).toBe(false);
    expect(record.targetDevice).toBeNull();
    expect(record.tone).toBeNull();
    expect(record.acknowledgedAt).toBeNull();
    expect(record.followUpCount).toBe(0);
    expect(record.lastFollowUpAt).toBeNull();
    store.close();
  });

  test("persists announce/targetDevice/tone through create and get", () => {
    const store = new ReminderStore(":memory:");
    const record = store.create({
      text: "Take medication",
      dueAt: "2026-01-15T08:00:00.000Z",
      announce: true,
      targetDevice: "mac-1",
      tone: "formal",
    });

    const fetched = store.get(record.id);
    expect(fetched?.announce).toBe(true);
    expect(fetched?.targetDevice).toBe("mac-1");
    expect(fetched?.tone).toBe("formal");
    store.close();
  });

  test("markAcknowledged sets acknowledgedAt", () => {
    const store = new ReminderStore(":memory:");
    const record = store.create({ text: "Stretch", announce: true });
    store.markAcknowledged(record.id, "2026-01-15T09:00:00.000Z");

    expect(store.get(record.id)?.acknowledgedAt).toBe("2026-01-15T09:00:00.000Z");
    store.close();
  });

  test("recordFollowUpAttempt increments followUpCount and stamps lastFollowUpAt", () => {
    const store = new ReminderStore(":memory:");
    const record = store.create({ text: "Stretch", announce: true });

    store.recordFollowUpAttempt(record.id, "2026-01-15T09:00:00.000Z");
    let fetched = store.get(record.id)!;
    expect(fetched.followUpCount).toBe(1);
    expect(fetched.lastFollowUpAt).toBe("2026-01-15T09:00:00.000Z");

    store.recordFollowUpAttempt(record.id, "2026-01-15T09:05:00.000Z");
    fetched = store.get(record.id)!;
    expect(fetched.followUpCount).toBe(2);
    expect(fetched.lastFollowUpAt).toBe("2026-01-15T09:05:00.000Z");
    store.close();
  });

  test("update can change announce/targetDevice/tone", () => {
    const store = new ReminderStore(":memory:");
    const record = store.create({ text: "Stretch" });

    const updated = store.update(record.id, { announce: true, targetDevice: "all", tone: "formal" });
    expect(updated?.announce).toBe(true);
    expect(updated?.targetDevice).toBe("all");
    expect(updated?.tone).toBe("formal");
    store.close();
  });

  test("re-dating an announce reminder clears acknowledgedAt/followUpCount/lastFollowUpAt, same as notifiedAt", () => {
    const store = new ReminderStore(":memory:");
    const record = store.create({ text: "Stretch", dueAt: "2026-01-15T08:00:00.000Z", announce: true });
    store.markAcknowledged(record.id, "2026-01-15T08:01:00.000Z");
    store.recordFollowUpAttempt(record.id, "2026-01-15T08:05:00.000Z");

    const updated = store.update(record.id, { dueAt: "2026-01-16T08:00:00.000Z" });
    expect(updated?.acknowledgedAt).toBeNull();
    expect(updated?.followUpCount).toBe(0);
    expect(updated?.lastFollowUpAt).toBeNull();
    store.close();
  });
});

describe("composeAnnouncementText", () => {
  test("casual (default) initial announcement", () => {
    expect(composeAnnouncementText("take out the trash", null, false)).toContain("take out the trash");
    expect(composeAnnouncementText("take out the trash", "casual", false)).toMatch(/hey david/i);
  });

  test("formal initial announcement addresses the user as sir", () => {
    expect(composeAnnouncementText("take out the trash", "formal", false)).toMatch(/sir/i);
  });

  test("follow-up phrasing differs from the initial announcement", () => {
    const initial = composeAnnouncementText("take out the trash", "casual", false);
    const followUp = composeAnnouncementText("take out the trash", "casual", true);
    expect(initial).not.toBe(followUp);
    expect(followUp).toMatch(/did you/i);
  });
});

describe("getAnnounceFollowUps", () => {
  test("ignores a reminder that isn't an announce reminder", () => {
    const reminders = [makeReminder({ announce: false })];
    expect(getAnnounceFollowUps(reminders, "2026-01-15T08:10:00.000Z")).toHaveLength(0);
  });

  test("ignores a reminder that hasn't been announced yet", () => {
    const reminders = [makeReminder({ notifiedAt: null })];
    expect(getAnnounceFollowUps(reminders, "2026-01-15T08:10:00.000Z")).toHaveLength(0);
  });

  test("ignores an already-acknowledged reminder", () => {
    const reminders = [makeReminder({ acknowledgedAt: "2026-01-15T08:01:00.000Z" })];
    expect(getAnnounceFollowUps(reminders, "2026-01-15T08:10:00.000Z")).toHaveLength(0);
  });

  test("does not follow up before the interval elapses", () => {
    const reminders = [makeReminder({ notifiedAt: "2026-01-15T08:00:00.000Z" })];
    const almostThere = new Date(Date.parse("2026-01-15T08:00:00.000Z") + ANNOUNCE_FOLLOW_UP_INTERVAL_MS - 1000).toISOString();
    expect(getAnnounceFollowUps(reminders, almostThere)).toHaveLength(0);
  });

  test("follows up once the interval has elapsed since the initial announcement", () => {
    const reminders = [makeReminder({ notifiedAt: "2026-01-15T08:00:00.000Z" })];
    const dueTime = new Date(Date.parse("2026-01-15T08:00:00.000Z") + ANNOUNCE_FOLLOW_UP_INTERVAL_MS).toISOString();
    expect(getAnnounceFollowUps(reminders, dueTime)).toHaveLength(1);
  });

  test("paces off lastFollowUpAt, not the original notifiedAt, once a follow-up has happened", () => {
    const reminders = [
      makeReminder({
        notifiedAt: "2026-01-15T08:00:00.000Z",
        followUpCount: 1,
        lastFollowUpAt: "2026-01-15T08:10:00.000Z",
      }),
    ];
    const tooSoon = new Date(Date.parse("2026-01-15T08:10:00.000Z") + ANNOUNCE_FOLLOW_UP_INTERVAL_MS - 1000).toISOString();
    expect(getAnnounceFollowUps(reminders, tooSoon)).toHaveLength(0);

    const dueTime = new Date(Date.parse("2026-01-15T08:10:00.000Z") + ANNOUNCE_FOLLOW_UP_INTERVAL_MS).toISOString();
    expect(getAnnounceFollowUps(reminders, dueTime)).toHaveLength(1);
  });

  test("stops once the follow-up budget is exhausted", () => {
    const reminders = [
      makeReminder({
        notifiedAt: "2026-01-15T08:00:00.000Z",
        followUpCount: MAX_ANNOUNCE_FOLLOW_UPS,
        lastFollowUpAt: "2026-01-15T08:10:00.000Z",
      }),
    ];
    const farInFuture = "2026-02-01T00:00:00.000Z";
    expect(getAnnounceFollowUps(reminders, farInFuture)).toHaveLength(0);
  });

  test("excludes an id already in flight", () => {
    const reminders = [makeReminder({ notifiedAt: "2026-01-15T08:00:00.000Z", id: "r1" })];
    const dueTime = new Date(Date.parse("2026-01-15T08:00:00.000Z") + ANNOUNCE_FOLLOW_UP_INTERVAL_MS).toISOString();
    expect(getAnnounceFollowUps(reminders, dueTime, new Set(["r1"]))).toHaveLength(0);
  });
});

function stubDeviceRegistry(primaryId: string | undefined): DeviceRegistry {
  return {
    getPrimaryDevice: () => (primaryId ? { id: primaryId } : undefined),
  } as unknown as DeviceRegistry;
}

function stubConnectionManager(connectedIds: string[]): DeviceConnectionManager {
  return {
    hasConnection: (id: string) => connectedIds.includes(id),
    listConnectedDeviceIds: () => connectedIds,
  } as unknown as DeviceConnectionManager;
}

describe("resolveAnnounceTargets", () => {
  test('"all" returns every currently-connected device', () => {
    const result = resolveAnnounceTargets(ANNOUNCE_TARGET_ALL, stubDeviceRegistry(undefined), stubConnectionManager(["mac-1", "phone-1"]));
    expect(result).toEqual(["mac-1", "phone-1"]);
  });

  test("a specific connected device id resolves to just that device", () => {
    const result = resolveAnnounceTargets("mac-1", stubDeviceRegistry(undefined), stubConnectionManager(["mac-1", "phone-1"]));
    expect(result).toEqual(["mac-1"]);
  });

  test("a specific but disconnected device id resolves to nothing", () => {
    const result = resolveAnnounceTargets("mac-1", stubDeviceRegistry(undefined), stubConnectionManager(["phone-1"]));
    expect(result).toEqual([]);
  });

  test("null (wherever available) prefers the connected primary device", () => {
    const result = resolveAnnounceTargets(null, stubDeviceRegistry("mac-1"), stubConnectionManager(["mac-1", "phone-1"]));
    expect(result).toEqual(["mac-1"]);
  });

  test("null falls back to any connected device when the primary isn't connected", () => {
    const result = resolveAnnounceTargets(null, stubDeviceRegistry("mac-1"), stubConnectionManager(["phone-1"]));
    expect(result).toEqual(["phone-1"]);
  });

  test("null resolves to nothing when no device is connected", () => {
    const result = resolveAnnounceTargets(null, stubDeviceRegistry("mac-1"), stubConnectionManager([]));
    expect(result).toEqual([]);
  });
});
