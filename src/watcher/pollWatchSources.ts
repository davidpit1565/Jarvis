import type { WatchSource } from "@/watcher/WatchSource";
import type { WatcherStore } from "@/watcher/WatcherStore";

/**
 * Polls every given `WatchSource` once against `store`, recording whatever
 * each one reports as new since its last cursor. The generic counterpart to
 * `pollGitHubActivity` (same shape of guarantee): each source is handled
 * independently — a failure polling one source (network error, bad feed,
 * rate limit) is reported via `onError` and skipped, never crashes the
 * others and never throws out of this function, so a caller (a scheduler
 * tick) never needs its own try/catch around this to stay safe.
 */
export async function pollWatchSources<TCursor, TItem>(
  sources: Array<WatchSource<TCursor, TItem>>,
  store: WatcherStore,
  onError: (sourceId: string, error: unknown) => void = (sourceId, error) =>
    console.error(`[jarvis] watch source poll failed for "${sourceId}":`, error instanceof Error ? error.message : String(error))
): Promise<void> {
  for (const source of sources) {
    try {
      const previousCursor = store.getCursor<TCursor>(source.id);
      const { newItems, nextCursor } = await source.poll(previousCursor);
      store.recordPoll(source.id, nextCursor, newItems);
    } catch (error) {
      onError(source.id, error);
    }
  }
}
