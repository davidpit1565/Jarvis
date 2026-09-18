import { describe, test, expect } from "bun:test";
import { UndoStore } from "@/core/undo/UndoStore";

describe("UndoStore", () => {
  test("returns undefined when nothing has been recorded", () => {
    const store = new UndoStore();
    expect(store.takeLast()).toBeUndefined();
  });

  test("returns the recorded action", () => {
    const store = new UndoStore();
    store.record({ type: "calendar_event_created", eventId: "e1", summary: "Dentist" });
    expect(store.takeLast()).toEqual({ type: "calendar_event_created", eventId: "e1", summary: "Dentist" });
  });

  test("taking the action clears it — a second take returns undefined", () => {
    const store = new UndoStore();
    store.record({ type: "calendar_event_created", eventId: "e1", summary: "Dentist" });
    store.takeLast();
    expect(store.takeLast()).toBeUndefined();
  });

  test("recording a new action replaces the previous one", () => {
    const store = new UndoStore();
    store.record({ type: "calendar_event_created", eventId: "e1", summary: "First" });
    store.record({ type: "calendar_event_created", eventId: "e2", summary: "Second" });
    expect(store.takeLast()).toEqual({ type: "calendar_event_created", eventId: "e2", summary: "Second" });
  });
});
