import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { BehaviorCorrectionStore } from "@/behavior/BehaviorCorrectionStore";
import { correctionNote } from "@/behavior/correctionNote";

describe("correctionNote", () => {
  let store: BehaviorCorrectionStore;

  beforeEach(() => {
    store = new BehaviorCorrectionStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  test("returns undefined when nothing is stored", () => {
    expect(correctionNote(store, "remind me to call mom tomorrow")).toBeUndefined();
  });

  test("surfaces a correction relevant to the current message's topic", () => {
    store.add({
      contextKey: "CREATE_REMINDER",
      correction: "ask for a specific time instead of assuming morning",
      originalAction: "CREATE_REMINDER",
      triggeringMessage: "no, 6pm not 6am",
    });

    const note = correctionNote(store, "remind me to water the plants");
    expect(note).toContain("ask for a specific time instead of assuming morning");
  });

  test("does not surface a correction filed under an unrelated topic", () => {
    store.add({
      contextKey: "SEND_EMAIL",
      correction: "always cc my assistant",
      originalAction: "SEND_EMAIL",
      triggeringMessage: "cc her too",
    });

    expect(correctionNote(store, "remind me to call mom tomorrow")).toBeUndefined();
  });

  test("returns undefined for an ambiguous/multi-topic message rather than showing everything stored", () => {
    store.add({
      contextKey: "CREATE_REMINDER",
      correction: "ask for a specific time",
      originalAction: "CREATE_REMINDER",
      triggeringMessage: "no",
    });

    // Mentions both "reminder" and "weather" keywords -> two topics classified -> ambiguous.
    expect(correctionNote(store, "remind me to check the weather forecast")).toBeUndefined();
  });

  test("returns undefined for a message with no classifiable topic at all", () => {
    store.add({
      contextKey: "CREATE_REMINDER",
      correction: "ask for a specific time",
      originalAction: "CREATE_REMINDER",
      triggeringMessage: "no",
    });

    expect(correctionNote(store, "good morning")).toBeUndefined();
  });

  test("includes an explicit caveat for a correction flagged as conflicting with a standing preference", () => {
    store.add({
      contextKey: "SEND_EMAIL",
      correction: "always cc my assistant on outgoing emails",
      originalAction: "SEND_EMAIL",
      triggeringMessage: "cc her from now on",
      flaggedPreferenceConflict: true,
      conflictingPreference: "never cc anyone on my emails without asking first",
    });

    const note = correctionNote(store, "send an email to the team");
    expect(note).toContain("always cc my assistant on outgoing emails");
    expect(note).toContain("conflict");
    expect(note).toContain("never cc anyone on my emails without asking first");
  });
});
