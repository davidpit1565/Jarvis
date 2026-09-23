export type ReminderRecurrence = "daily" | "weekly";

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
}

export interface CreateReminderInput {
  text: string;
  dueAt?: string | null;
  recurrence?: ReminderRecurrence | null;
  /** Defaults to false (a normal new reminder). Set true only to restore a previously-completed reminder (e.g. undoing its deletion) without going through complete()'s recurrence-advance side effect. */
  completed?: boolean;
}
