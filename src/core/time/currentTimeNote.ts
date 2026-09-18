/**
 * Formats the current date/time for the system prompt, in both UTC (exact,
 * for the model to compute with) and the configured local timezone (for
 * the model to read naturally). Without this, Claude has no ground truth
 * for "now" at all — it can't reliably resolve "remind me tomorrow at
 * 9am" or "in two hours" into an actual timestamp, since its training
 * data has no idea what day it actually is right now.
 */
export function currentTimeNote(timezone: string): string {
  const now = new Date();
  const iso = now.toISOString();

  let local: string;
  try {
    local = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    }).format(now);
  } catch {
    // An invalid IANA timezone string (caught at config load, but this
    // stays defensive rather than throwing mid-conversation) falls back
    // to UTC rather than crashing the turn.
    local = `${iso} UTC`;
  }

  return (
    `Current date/time: ${iso} (UTC). In the user's local timezone (${timezone}): ${local}. ` +
    "Use this as ground truth for \"now\" — resolve relative times (\"tomorrow\", \"in 2 hours\", " +
    '"6pm") against it, not your training data, when calling create_reminder/update_reminder.'
  );
}
