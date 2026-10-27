export type ReminderRecurrence = "daily" | "weekly";

/**
 * How a proactive, device-spoken announcement should be phrased — a simple
 * tunable parameter rather than a full configurable-style system (see
 * CLAUDE.md wishlist #19: "a tone he can tune, more casual vs. more
 * professional/diplomatic"). `null`/omitted behaves exactly like "casual".
 */
export type ReminderTone = "casual" | "formal";

/**
 * Either a specific known device id, or the literal "all" meaning every
 * currently-connected device. `null` means "wherever available" — resolved
 * at announce-time to the primary device if connected, else any connected
 * device (see resolveAnnounceTargets).
 */
export type ReminderTargetDevice = string;

export interface ReminderRecord {
  id: string;
  text: string;
  /** ISO timestamp the reminder is due at, or null for an undated task. */
  dueAt: string | null;
  completed: boolean;
  createdAt: string;
  /** null for a one-off reminder. When set, completing it (with a dueAt set) creates the next occurrence automatically. */
  recurrence: ReminderRecurrence | null;
  /** ISO timestamp a due-reminder push notification was actually sent at, or null if none has been sent yet. */
  notifiedAt: string | null;
  /**
   * When true, a due reminder is spoken live through a connected device
   * (see ProactiveAnnouncer) instead of only a silent push/Telegram
   * notification. Defaults to false — existing reminders are completely
   * unaffected by this feature.
   */
  announce: boolean;
  /**
   * Which device (by id) or "all" to speak an `announce` reminder through.
   * `null` means "wherever available" (see ReminderTargetDevice).
   */
  targetDevice: ReminderTargetDevice | null;
  /** Phrasing tone for an `announce` reminder's spoken text. `null` behaves like "casual". */
  tone: ReminderTone | null;
  /**
   * ISO timestamp the owner's spoken reply to this reminder's announcement
   * was authenticated (see SpeakerAuthenticator) — once set, the follow-up
   * engine stops re-announcing it. `null` until that happens.
   */
  acknowledgedAt: string | null;
  /** How many bounded follow-up announcements ("did you do it?") have been sent so far. See getAnnounceFollowUps. */
  followUpCount: number;
  /** ISO timestamp of the most recent follow-up announcement, or null if none has been sent yet. */
  lastFollowUpAt: string | null;
}

export interface CreateReminderInput {
  text: string;
  dueAt?: string | null;
  recurrence?: ReminderRecurrence | null;
  /** Defaults to false (a normal new reminder). Set true only to restore a previously-completed reminder (e.g. undoing its deletion) without going through complete()'s recurrence-advance side effect. */
  completed?: boolean;
  /** See ReminderRecord.announce. Defaults to false. */
  announce?: boolean;
  /** See ReminderRecord.targetDevice. */
  targetDevice?: ReminderTargetDevice | null;
  /** See ReminderRecord.tone. */
  tone?: ReminderTone | null;
}
