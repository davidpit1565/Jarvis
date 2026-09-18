export interface WakeUpCallRecord {
  id: string;
  /** 24-hour "HH:MM" in the configured JARVIS_TIMEZONE, e.g. "07:00". */
  timeOfDay: string;
  /** Optional description, e.g. "weekday wake-up". */
  label: string | null;
  enabled: boolean;
  /** "YYYY-MM-DD" the call last actually went out, or null if it never has — prevents re-triggering within the same day. */
  lastTriggeredDate: string | null;
  createdAt: string;
}

export interface CreateWakeUpCallInput {
  timeOfDay: string;
  label?: string | null;
}
