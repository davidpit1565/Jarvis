export interface CalendarEvent {
  id: string;
  summary: string;
  /** ISO 8601 timestamp for a timed event, or a "YYYY-MM-DD" date for an all-day event. */
  start: string;
  end: string;
  location: string | null;
}
