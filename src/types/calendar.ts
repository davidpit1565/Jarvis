export interface CalendarEvent {
  id: string;
  summary: string;
  /** ISO 8601 timestamp for a timed event, or a "YYYY-MM-DD" date for an all-day event. */
  start: string;
  end: string;
  location: string | null;
  /** Which linked Google account (its email) this event belongs to — lets a multi-account aggregated result say "in your work account". */
  account: string;
}

export interface CalendarEventDetail extends CalendarEvent {
  description: string | null;
  attendees: string[];
}

export interface CreateCalendarEventInput {
  summary: string;
  /** ISO 8601 timestamp the event starts at. */
  start: string;
  /** ISO 8601 timestamp the event ends at. */
  end: string;
  location?: string | null;
}
