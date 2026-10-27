import { describe, test, expect } from "bun:test";
import { createPollScheduler } from "@/watcher/scheduler";

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("createPollScheduler", () => {
  test("runs every registered job on each tick", async () => {
    let calls1 = 0;
    let calls2 = 0;
    const scheduler = createPollScheduler(
      [
        async () => {
          calls1++;
        },
        async () => {
          calls2++;
        },
      ],
      10
    );

    await wait(35);
    scheduler.stop();

    expect(calls1).toBeGreaterThanOrEqual(2);
    expect(calls2).toBeGreaterThanOrEqual(2);
  });

  test("a slow job overlapping the next tick is not run twice concurrently (in-flight guard)", async () => {
    let concurrentRuns = 0;
    let maxConcurrent = 0;
    let totalRuns = 0;

    const scheduler = createPollScheduler(
      [
        async () => {
          concurrentRuns++;
          maxConcurrent = Math.max(maxConcurrent, concurrentRuns);
          totalRuns++;
          await wait(30);
          concurrentRuns--;
        },
      ],
      10
    );

    await wait(70);
    scheduler.stop();

    expect(maxConcurrent).toBe(1);
    expect(totalRuns).toBeGreaterThanOrEqual(1);
  });

  test("one job throwing doesn't stop other jobs in the same tick or crash the scheduler", async () => {
    let goodCalls = 0;
    const scheduler = createPollScheduler(
      [
        async () => {
          throw new Error("boom");
        },
        async () => {
          goodCalls++;
        },
      ],
      10
    );

    await wait(35);
    scheduler.stop();

    expect(goodCalls).toBeGreaterThanOrEqual(2);
  });

  test("stop() halts further ticks", async () => {
    let calls = 0;
    const scheduler = createPollScheduler(
      [
        async () => {
          calls++;
        },
      ],
      10
    );
    await wait(15);
    scheduler.stop();
    const callsAtStop = calls;
    await wait(30);
    expect(calls).toBe(callsAtStop);
  });
});
