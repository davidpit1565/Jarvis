export interface ReminderRecord {
  id: string;
  text: string;
  /** ISO timestamp the reminder is due at, or null for an undated task. */
  dueAt: string | null;
  completed: boolean;
  createdAt: string;
}

export interface CreateReminderInput {
  text: string;
  dueAt?: string | null;
}
