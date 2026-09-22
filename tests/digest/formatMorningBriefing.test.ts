import { describe, test, expect } from "bun:test";
import { formatMorningBriefing } from "@/digest/formatMorningBriefing";

describe("formatMorningBriefing", () => {
  test("includes weather, calendar, and reminders when all are present", () => {
    const text = formatMorningBriefing(
      { temperatureC: 18, windSpeedKph: 5, description: "clear sky", isDay: true },
      [{ id: "e1", summary: "Team sync", start: "2026-01-15T09:00:00Z", end: "2026-01-15T09:30:00Z", location: "Zoom", account: "me@example.com" }],
      [{ id: "r1", text: "Take medication", dueAt: "2026-01-15T08:00:00Z", completed: false, createdAt: "x", recurrence: null, notifiedAt: null }]
    );

    expect(text).toContain("18°C, clear sky");
    expect(text).toContain("Team sync");
    expect(text).toContain("Zoom");
    expect(text).toContain("Take medication");
  });

  test("omits sections with nothing to report", () => {
    const text = formatMorningBriefing(undefined, [], []);

    expect(text).not.toContain("Weather:");
    expect(text).not.toContain("Today's calendar:");
    expect(text).not.toContain("Due or overdue reminders:");
    expect(text).toContain("Good morning!");
  });

  test("omits weather when not configured but still includes calendar/reminders", () => {
    const text = formatMorningBriefing(
      undefined,
      [{ id: "e1", summary: "Standup", start: "2026-01-15T09:00:00Z", end: "2026-01-15T09:15:00Z", location: null, account: "me@example.com" }],
      []
    );

    expect(text).not.toContain("Weather:");
    expect(text).toContain("Standup");
  });
});
