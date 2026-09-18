export interface AlarmRecord {
  id: string;
  /** 24-hour "HH:MM" in the configured JARVIS_TIMEZONE, e.g. "07:00". */
  timeOfDay: string;
  /** Optional description, e.g. "gym alarm". */
  label: string | null;
  enabled: boolean;
  /** "YYYY-MM-DD" the alarm last actually fired, or null if it never has — prevents re-triggering within the same day. */
  lastTriggeredDate: string | null;
  createdAt: string;
}

export interface CreateAlarmInput {
  timeOfDay: string;
  label?: string | null;
}
