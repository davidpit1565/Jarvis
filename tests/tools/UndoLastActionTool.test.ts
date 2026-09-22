import { describe, test, expect, afterEach } from "bun:test";
import { CalendarTokenStore } from "@/calendar/CalendarTokenStore";
import { GoogleCalendarClient } from "@/calendar/GoogleCalendarClient";
import { ReminderStore } from "@/reminders/ReminderStore";
import { MemoryStore } from "@/memory/MemoryStore";
import { UndoStore } from "@/core/undo/UndoStore";
import { createUndoLastActionTool } from "@/tools/undo/UndoLastActionTool";
import { PermissionLevel } from "@/types/permissions";

const context = { userId: "user-1", requestId: "req-1" };
const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

function makeClient() {
  const tokenStore = new CalendarTokenStore(":memory:");
  tokenStore.save("me@example.com", { refreshToken: "r1", accessToken: "a1", accessTokenExpiresAt: Date.now() + 3_600_000 });
  return new GoogleCalendarClient("id", "secret", "https://example.com/callback", tokenStore);
}

describe("UNDO_LAST_ACTION tool", () => {
  test("is SAFE_ACTION", () => {
    const tool = createUndoLastActionTool(new UndoStore(), makeClient());
    expect(tool.requiredPermission).toBe(PermissionLevel.SAFE_ACTION);
  });

  test("returns a failure result when there's nothing to undo", async () => {
    const tool = createUndoLastActionTool(new UndoStore(), makeClient());
    const result = await tool.execute({}, context);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Nothing to undo");
  });

  test("deletes the last-created calendar event", async () => {
    let deletedEventId: string | undefined;
    global.fetch = (async (url: string, init?: RequestInit) => {
      deletedEventId = decodeURIComponent(url.split("/").pop() ?? "");
      expect(init?.method).toBe("DELETE");
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;

    const undoStore = new UndoStore();
    undoStore.record({ type: "calendar_event_created", eventId: "e1", summary: "Dentist" });
    const tool = createUndoLastActionTool(undoStore, makeClient());

    const result = await tool.execute({}, context);

    expect(result.success).toBe(true);
    expect(deletedEventId).toBe("e1");
  });

  test("taking the action clears the undo store — undoing twice fails the second time", async () => {
    global.fetch = (async () => new Response(null, { status: 204 })) as unknown as typeof fetch;

    const undoStore = new UndoStore();
    undoStore.record({ type: "calendar_event_created", eventId: "e1", summary: "Dentist" });
    const tool = createUndoLastActionTool(undoStore, makeClient());

    await tool.execute({}, context);
    const second = await tool.execute({}, context);

    expect(second.success).toBe(false);
  });

  test("returns a failure result (not a throw) when the delete fails", async () => {
    global.fetch = (async () => new Response("forbidden", { status: 403 })) as unknown as typeof fetch;

    const undoStore = new UndoStore();
    undoStore.record({ type: "calendar_event_created", eventId: "e1", summary: "Dentist" });
    const tool = createUndoLastActionTool(undoStore, makeClient());

    const result = await tool.execute({}, context);
    expect(result.success).toBe(false);
  });

  test("recreates a just-deleted calendar event", async () => {
    let capturedBody: string | undefined;
    global.fetch = (async (_url: string, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return new Response(JSON.stringify({ id: "new-id", summary: "Dentist", start: {}, end: {} }), { status: 200 });
    }) as unknown as typeof fetch;

    const undoStore = new UndoStore();
    undoStore.record({
      type: "calendar_event_deleted",
      summary: "Dentist",
      start: "2026-01-20T10:00:00Z",
      end: "2026-01-20T10:30:00Z",
      location: "Clinic",
    });
    const tool = createUndoLastActionTool(undoStore, makeClient());

    const result = await tool.execute({}, context);

    expect(result.success).toBe(true);
    const body = JSON.parse(capturedBody!);
    expect(body.summary).toBe("Dentist");
    expect(body.location).toBe("Clinic");
  });

  test("restores a just-updated calendar event's previous values", async () => {
    let capturedMethod: string | undefined;
    let capturedBody: string | undefined;
    global.fetch = (async (_url: string, init?: RequestInit) => {
      capturedMethod = init?.method;
      capturedBody = init?.body as string;
      return new Response(JSON.stringify({ id: "ev1", summary: "Dentist", start: {}, end: {} }), { status: 200 });
    }) as unknown as typeof fetch;

    const undoStore = new UndoStore();
    undoStore.record({
      type: "calendar_event_updated",
      eventId: "ev1",
      previous: { summary: "Dentist", start: "2026-01-20T10:00:00Z", end: "2026-01-20T10:30:00Z", location: "Clinic" },
    });
    const tool = createUndoLastActionTool(undoStore, makeClient());

    const result = await tool.execute({}, context);

    expect(result.success).toBe(true);
    expect(capturedMethod).toBe("PATCH");
    const body = JSON.parse(capturedBody!);
    expect(body.summary).toBe("Dentist");
    expect(body.location).toBe("Clinic");
  });

  test("recreates a just-deleted reminder", async () => {
    const reminderStore = new ReminderStore(":memory:");
    const undoStore = new UndoStore();
    undoStore.record({
      type: "reminder_deleted",
      text: "Buy milk",
      dueAt: "2026-09-19T18:00:00.000Z",
      recurrence: "daily",
    });
    const tool = createUndoLastActionTool(undoStore, undefined, reminderStore);

    const result = await tool.execute({}, context);

    expect(result.success).toBe(true);
    const [recreated] = reminderStore.list();
    expect(recreated?.text).toBe("Buy milk");
    expect(recreated?.recurrence).toBe("daily");
    reminderStore.close();
  });

  test("fails to undo a reminder deletion when no reminderStore was given", async () => {
    const undoStore = new UndoStore();
    undoStore.record({ type: "reminder_deleted", text: "Buy milk", dueAt: null, recurrence: null });
    const tool = createUndoLastActionTool(undoStore, makeClient());

    const result = await tool.execute({}, context);
    expect(result.success).toBe(false);
  });

  test("fails to undo a calendar action when no calendarClient was given", async () => {
    const reminderStore = new ReminderStore(":memory:");
    const undoStore = new UndoStore();
    undoStore.record({ type: "calendar_event_created", eventId: "e1", summary: "Dentist" });
    const tool = createUndoLastActionTool(undoStore, undefined, reminderStore);

    const result = await tool.execute({}, context);
    expect(result.success).toBe(false);
    reminderStore.close();
  });

  test("restores a just-deleted memory fact", async () => {
    const memoryStore = new MemoryStore(":memory:");
    const undoStore = new UndoStore();
    undoStore.record({ type: "memory_deleted", key: "user.oldJob", value: "Acme Corp" });
    const tool = createUndoLastActionTool(undoStore, undefined, undefined, memoryStore);

    const result = await tool.execute({}, context);

    expect(result.success).toBe(true);
    expect(memoryStore.getByKey("user.oldJob")?.value).toBe("Acme Corp");
    memoryStore.close();
  });

  test("fails to undo a memory deletion when no memoryStore was given", async () => {
    const undoStore = new UndoStore();
    undoStore.record({ type: "memory_deleted", key: "user.oldJob", value: "Acme Corp" });
    const tool = createUndoLastActionTool(undoStore);

    const result = await tool.execute({}, context);
    expect(result.success).toBe(false);
  });
});
