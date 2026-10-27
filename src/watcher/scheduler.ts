/** One independent, self-contained poll job for a tick — expected to isolate its own internal failures (as `pollGitHubActivity`/`pollWatchSources` both already do) rather than relying on the scheduler to catch anything thrown mid-poll for one source. */
export type PollJob = () => Promise<void>;

export interface PollScheduler {
  stop(): void;
}

/**
 * A single shared interval driving an arbitrary list of independent poll
 * jobs (GitHub's `pollGitHubActivity`, a news `pollWatchSources` call,
 * eventually Gmail) — the generic polling runner `CLAUDE.md`'s "Approved
 * for build: generalized Proactive Watcher" spec asks for, so every new
 * proactive source doesn't need its own bespoke `setInterval` + in-flight
 * guard copy-pasted into index.ts (the way GitHub's own activity interval
 * was before this change).
 *
 * In-flight overlap guard: a single boolean, same shape as the GitHub
 * activity interval's existing `pollInFlight` guard it replaces — a tick
 * landing while the previous tick's jobs are still running is simply
 * skipped (not queued, not run concurrently), because all jobs share one
 * interval and a slow job must not cause two overlapping rounds of polling.
 * Per-job isolation: `Promise.allSettled` means one job throwing (should
 * never happen if each job follows the same isolate-failures-internally
 * contract `pollGitHubActivity`/`pollWatchSources` already have, but this
 * is defense in depth, not a replacement for that contract) never stops
 * the other jobs in the same tick from running, and never crashes the
 * scheduler itself.
 */
export function createPollScheduler(
  jobs: PollJob[],
  intervalMs: number,
  options: { onTick?: () => void; onJobError?: (error: unknown) => void } = {}
): PollScheduler {
  let inFlight = false;
  const interval = setInterval(() => {
    options.onTick?.();
    if (inFlight) return;
    inFlight = true;
    Promise.allSettled(
      jobs.map((job) =>
        job().catch((error) => {
          options.onJobError?.(error);
        })
      )
    ).finally(() => {
      inFlight = false;
    });
  }, intervalMs);

  return {
    stop: () => clearInterval(interval),
  };
}
