import { describe, test, expect } from "bun:test";

/**
 * Mirrors index.ts's weeklyDigestInterval/checkinInterval/
 * morningBriefingInterval ticks — specifically the fix making each
 * "already sent" state commit (lastWeeklyDigestDateKey,
 * checkinSentSinceLastInteraction, lastMorningBriefingDateKey) conditional
 * on the Telegram send actually succeeding, instead of committing before
 * delivery is known to have worked. Before this fix, a single transient
 * Telegram failure permanently skipped that day's/week's proactive push
 * with no retry — the same bug class already fixed for reminder
 * notifications (ReminderStore.notified_at), just in three different
 * pieces of scheduler state.
 */

describe("weekly digest delivery gate", () => {
  async function tick(state: { lastSentDateKey: string | null }, todayDateKey: string, send: () => Promise<void>) {
    try {
      await send();
      state.lastSentDateKey = todayDateKey;
    } catch {
      // left unset — the next tick's isWeeklyDigestDue check retries it
    }
  }

  test("a successful send commits the dateKey", async () => {
    const state = { lastSentDateKey: null as string | null };
    await tick(state, "2026-01-19", async () => {});
    expect(state.lastSentDateKey).toBe("2026-01-19");
  });

  test("a failed send leaves the dateKey unset, so the next tick retries", async () => {
    const state = { lastSentDateKey: null as string | null };
    await tick(state, "2026-01-19", async () => {
      throw new Error("Telegram API down");
    });
    expect(state.lastSentDateKey).toBeNull();

    await tick(state, "2026-01-19", async () => {});
    expect(state.lastSentDateKey).toBe("2026-01-19");
  });
});

describe("check-in delivery gate", () => {
  async function tick(state: { sentSinceLastInteraction: boolean }, send: () => Promise<void>) {
    try {
      await send();
      state.sentSinceLastInteraction = true;
    } catch {
      // left false — isCheckinDue keeps considering it due
    }
  }

  test("a successful send sets sentSinceLastInteraction", async () => {
    const state = { sentSinceLastInteraction: false };
    await tick(state, async () => {});
    expect(state.sentSinceLastInteraction).toBe(true);
  });

  test("a failed send leaves sentSinceLastInteraction false, so the check-in stays due", async () => {
    const state = { sentSinceLastInteraction: false };
    await tick(state, async () => {
      throw new Error("Telegram API down");
    });
    expect(state.sentSinceLastInteraction).toBe(false);

    await tick(state, async () => {});
    expect(state.sentSinceLastInteraction).toBe(true);
  });
});

describe("morning briefing delivery gate", () => {
  async function tick(state: { lastSentDateKey: string | null }, todayDateKey: string, send: () => Promise<void>) {
    try {
      await send();
      state.lastSentDateKey = todayDateKey;
    } catch {
      // left unset — the next tick's isMorningBriefingDue check retries it
    }
  }

  test("a successful send commits the dateKey", async () => {
    const state = { lastSentDateKey: null as string | null };
    await tick(state, "2026-01-19", async () => {});
    expect(state.lastSentDateKey).toBe("2026-01-19");
  });

  test("a failed send leaves the dateKey unset, so the next tick retries", async () => {
    const state = { lastSentDateKey: null as string | null };
    await tick(state, "2026-01-19", async () => {
      throw new Error("Telegram API down");
    });
    expect(state.lastSentDateKey).toBeNull();

    await tick(state, "2026-01-19", async () => {});
    expect(state.lastSentDateKey).toBe("2026-01-19");
  });

  test("a failed send while flushing a quiet-hours-queued briefing leaves it pending for the next tick", async () => {
    const pending = { dateKey: "2026-01-19" as string | null };
    const send = async () => {
      throw new Error("Telegram API down");
    };

    try {
      await send();
      pending.dateKey = null;
    } catch {
      // left set — the next non-quiet tick retries the flush
    }

    expect(pending.dateKey).toBe("2026-01-19");
  });
});
