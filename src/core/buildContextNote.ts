import type { JarvisConfig } from "@/config";
import type { ReminderStore } from "@/reminders/ReminderStore";
import type { GoogleCalendarClient } from "@/calendar/GoogleCalendarClient";
import type { CommitmentStore } from "@/commitments/CommitmentStore";
import type { GoalStore } from "@/agent/GoalStore";
import type { AgentTaskStore } from "@/agent/AgentTaskStore";
import type { BehaviorCorrectionStore } from "@/behavior/BehaviorCorrectionStore";
import type { GitHubActivityStore } from "@/github/GitHubActivityStore";
import type { WatcherStore } from "@/watcher/WatcherStore";
import type { WatchSource } from "@/watcher/WatchSource";
import { currentTimeNote } from "@/core/time/currentTimeNote";
import { dueRemindersNote } from "@/reminders/dueRemindersNote";
import { todayCalendarNote } from "@/calendar/todayCalendarNote";
import { staleCommitmentsNote } from "@/commitments/staleCommitmentsNote";
import { goalProgressNote } from "@/agent/goalProgressNote";
import { correctionNote } from "@/behavior/correctionNote";
import { githubActivityNote } from "@/github/githubActivityNote";
import { composeWatcherNote } from "@/watcher/watcherNote";
import { selfImprovementNote } from "@/watcher/selfImprovementNote";

/**
 * Combines every per-turn context note into the single string Orchestrator's
 * `contextProvider` expects. Kept as one small composition point rather
 * than wiring each note separately at both Orchestrator call sites
 * (terminal + phone) in index.ts. Async because calendar context requires
 * a real API call; the reminder/time/commitment/goal notes stay
 * synchronous internally. `commitmentStore` and the `goalStore`/
 * `taskStore`/`userId` trio are optional so call sites that predate them
 * (or tests) don't have to construct a Goal Engine just to build a
 * context note — both goal params must be given together or neither is
 * consulted. `correctionStore`/`currentMessage` are likewise optional and
 * independent of the rest: `correctionNote` (Correction Learning) only
 * produces anything when both are given AND the current message maps to
 * exactly one relevance topic — see its own doc comment for why an
 * ambiguous/multi-topic message surfaces nothing rather than everything.
 * `githubActivityStore` is likewise optional and independent of the rest:
 * when given, `githubActivityNote` (always-shown like goals, not
 * topic-gated like corrections — see its own doc comment for why) reads
 * whatever the background poller in index.ts most recently cached; when
 * omitted (GitHub proactive surfacing isn't configured), it contributes
 * nothing, the same inert-by-default behavior every other optional note
 * here already has.
 * `newsWatch` is the same shape of optional add-on for the generalized
 * Proactive Watcher's first non-GitHub source (CLAUDE.md "Approved for
 * build: generalized Proactive Watcher") — when both its `store` and
 * `sources` are given, `composeWatcherNote` reads whatever the shared
 * watcher scheduler in index.ts most recently cached for David's
 * configured `NEWS_WATCH_TOPICS`; omitted (no topics configured) means no
 * contribution, same inert-by-default posture as everything else here.
 * `selfImprovementWatcherStore`, likewise optional, reads whatever the
 * self-improvement watcher (`selfImprovementWatchSource.ts`) most recently
 * surfaced — a dedicated note composer (`selfImprovementNote`), not
 * `composeWatcherNote`, since this source's one item needs to carry a real
 * what/how/why explanation rather than a short flat description. Omitted
 * only when the feature itself is disabled (`SELF_IMPROVEMENT_WATCH_ENABLED=false`);
 * it's on by default elsewhere, unlike every other optional note here.
 */
export async function buildContextNote(
  config: Pick<JarvisConfig, "timezone">,
  reminderStore: ReminderStore,
  calendarClient?: GoogleCalendarClient,
  commitmentStore?: CommitmentStore,
  goals?: { goalStore: GoalStore; taskStore: AgentTaskStore; userId: string },
  correctionStore?: BehaviorCorrectionStore,
  currentMessage?: string,
  githubActivityStore?: GitHubActivityStore,
  newsWatch?: { store: WatcherStore; sources: Array<WatchSource<unknown, unknown>> },
  selfImprovementWatcherStore?: WatcherStore
): Promise<string> {
  const calendarNote = calendarClient ? await todayCalendarNote(calendarClient) : undefined;
  return [
    currentTimeNote(config.timezone),
    dueRemindersNote(reminderStore),
    calendarNote,
    commitmentStore ? staleCommitmentsNote(commitmentStore) : undefined,
    goals ? goalProgressNote(goals.goalStore, goals.taskStore, goals.userId) : undefined,
    correctionStore && currentMessage ? correctionNote(correctionStore, currentMessage) : undefined,
    githubActivityStore ? githubActivityNote(githubActivityStore) : undefined,
    newsWatch
      ? composeWatcherNote(newsWatch.store, newsWatch.sources, {
          intro: (count) =>
            `JARVIS has been watching the news for ${count} of the user's configured topic(s) that had new headlines since it last checked — ` +
            `feel free to mention something relevant naturally if it fits, without being asked`,
        })
      : undefined,
    selfImprovementWatcherStore ? selfImprovementNote(selfImprovementWatcherStore) : undefined,
  ]
    .filter(Boolean)
    .join("\n\n");
}
