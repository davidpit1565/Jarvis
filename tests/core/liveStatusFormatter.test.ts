import { describe, test, expect } from "bun:test";
import { formatLiveStatus, isLikelyStatusQuery } from "@/core/state/liveStatusFormatter";
import type { LiveStateSnapshot } from "@/core/state/JarvisLiveState";

function snapshot(overrides: Partial<LiveStateSnapshot> = {}): LiveStateSnapshot {
  return {
    sessionId: "chat:user-1",
    userId: "user-1",
    state: "IDLE",
    stopRequested: false,
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe("formatLiveStatus", () => {
  test("renders English by default when no language is known", () => {
    const text = formatLiveStatus(snapshot({ state: "THINKING" }));
    expect(text).toMatch(/thinking/i);
  });

  test("renders Hebrew when the snapshot's language is he", () => {
    const text = formatLiveStatus(snapshot({ state: "THINKING", language: "he" }));
    expect(text).toContain("חושב");
  });

  test("EXECUTING includes the real reason and current tool when given, never a canned line", () => {
    const text = formatLiveStatus(
      snapshot({ state: "EXECUTING", reason: "running 1 tool call(s)" }),
      { currentTool: "LIST_CALENDAR_EVENTS", goal: "check today's calendar" }
    );
    expect(text).toContain("LIST_CALENDAR_EVENTS");
    expect(text).toContain("check today's calendar");
    expect(text).toContain("running 1 tool call(s)");
  });

  test("IDLE reads as genuinely idle, not a generic 'working on it'", () => {
    const text = formatLiveStatus(snapshot({ state: "IDLE" }));
    expect(text).not.toMatch(/working on it/i);
    expect(text.toLowerCase()).toContain("not doing anything");
  });

  test("ERROR surfaces the real reason when present", () => {
    const text = formatLiveStatus(snapshot({ state: "ERROR", reason: "tool timed out" }));
    expect(text).toContain("tool timed out");
  });

  test("STOPPED reflects an actual user-requested stop", () => {
    const text = formatLiveStatus(snapshot({ state: "STOPPED" }));
    expect(text.toLowerCase()).toContain("stopped");
  });

  test("every LiveState renders a non-empty string in both languages", () => {
    const states: LiveStateSnapshot["state"][] = [
      "IDLE",
      "LISTENING",
      "THINKING",
      "PLANNING",
      "EXECUTING",
      "VERIFYING",
      "WAITING",
      "SPEAKING",
      "ERROR",
      "STOPPED",
    ];
    for (const state of states) {
      expect(formatLiveStatus(snapshot({ state, language: "en" })).length).toBeGreaterThan(0);
      expect(formatLiveStatus(snapshot({ state, language: "he" })).length).toBeGreaterThan(0);
    }
  });
});

describe("isLikelyStatusQuery", () => {
  test("matches literal English and Hebrew status-query phrases", () => {
    expect(isLikelyStatusQuery("what are you doing")).toBe(true);
    expect(isLikelyStatusQuery("What are you doing?")).toBe(true);
    expect(isLikelyStatusQuery("מה אתה עושה")).toBe(true);
  });

  test("does not match unrelated text", () => {
    expect(isLikelyStatusQuery("what is the weather today")).toBe(false);
    expect(isLikelyStatusQuery("")).toBe(false);
  });
});
