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

/**
 * Mirrors the in-flight-guard fix for all three schedulers above:
 * setInterval fires on a fixed wall-clock schedule regardless of whether
 * the previous tick's async send has resolved yet, and each "already sent"
 * commit only happens after that send resolves — so without a guard, a
 * slow send straddling a tick boundary lets a second tick see the same
 * "not sent yet" state and send a duplicate. A boolean flag set before the
 * async call and cleared in `finally` (checked at the top of the next
 * tick) prevents a second concurrent send while one is still in flight —
 * the same pattern already used by the automation-rule and wake-up-call
 * schedulers.
 */
describe("proactive-push in-flight guard", () => {
  async function tick(state: { sendInFlight: boolean; sent: number }, due: boolean, send: () => Promise<void>) {
    if (state.sendInFlight) return;
    if (!due) return;
    state.sendInFlight = true;
    try {
      await send();
      state.sent++;
    } finally {
      state.sendInFlight = false;
    }
  }

  test("a second tick landing while a send is still in flight does not start a duplicate send", async () => {
    const state = { sendInFlight: false, sent: 0 };
    let resolveFirstSend!: () => void;
    const firstSend = new Promise<void>((resolve) => {
      resolveFirstSend = resolve;
    });

    // Tick 1 starts a slow send and doesn't await it here (mirrors the
    // real scheduler: the interval callback is what awaits it, not the
    // test) — Tick 2 fires while it's still pending.
    const tick1 = tick(state, true, () => firstSend);
    const tick2 = tick(state, true, async () => {
      state.sent++;
    });

    resolveFirstSend();
    await Promise.all([tick1, tick2]);

    // Only the first tick's send actually ran — the second saw
    // sendInFlight already true and returned immediately.
    expect(state.sent).toBe(1);
  });

  test("once the in-flight send settles, the next tick can send normally", async () => {
    const state = { sendInFlight: false, sent: 0 };
    await tick(state, true, async () => {});
    expect(state.sendInFlight).toBe(false);

    await tick(state, true, async () => {});
    expect(state.sent).toBe(2);
  });
});
