import { formatDateKey, formatTimeOfDay } from "@/wakeup/getDueWakeUpCalls";

/** "HH:MM" 24-hour local-time bounds, e.g. { start: "22:00", end: "07:00" }. */
export interface QuietHoursWindow {
  start: string;
  end: string;
}

/** Every proactive notification path that could, in principle, be suppressed by quiet hours. */
export type NotificationType = "reminder" | "automation_rule_result" | "morning_briefing" | "alarm" | "wakeup_call";

/**
 * Time-critical types that quiet hours must NEVER suppress, regardless of
 * the configured window — the opt-out is per notification type, not a
 * blanket "no notifications between X and Y" rule (see
 * JarvisConfig.quietHoursStart's own doc comment).
 *
 * - "alarm" and "wakeup_call": the user set an exact time for these
 *   specifically because they want to be woken/alerted at that moment —
 *   suppressing an alarm because it's during quiet hours would defeat
 *   its entire purpose.
 * - Everything else ("reminder", "automation_rule_result",
 *   "morning_briefing") is a passive proactive notification with no
 *   inherent urgency, so it's suppressible by default.
 *
 * A tool-permission DANGEROUS tier is a different axis (risk of an
 * action, not urgency of a notification) and isn't reused here — nothing
 * in this codebase currently produces a DANGEROUS-tier *notification* to
 * exempt.
 */
const QUIET_HOURS_EXEMPT_TYPES: ReadonlySet<NotificationType> = new Set(["alarm", "wakeup_call"]);

/** Whether a notification of this type is even eligible to be suppressed by quiet hours at all. */
export function isSuppressibleByQuietHours(type: NotificationType): boolean {
  return !QUIET_HOURS_EXEMPT_TYPES.has(type);
}

/**
 * True when `nowTimeOfDay` ("HH:MM") falls inside the quiet-hours window.
 * Handles the normal case (start < end, e.g. "13:00"-"14:00") and the
 * overnight case that quiet hours actually need (start > end, e.g.
 * "22:00"-"07:00" spans midnight). `start === end` is treated as "quiet
 * hours disabled" (a zero-length window suppresses nothing) rather than
 * "always quiet" — an accidental JARVIS_QUIET_HOURS_START=JARVIS_QUIET_HOURS_END
 * should not silently swallow every proactive notification forever.
 */
export function isQuietHours(nowTimeOfDay: string, window: QuietHoursWindow | undefined): boolean {
  if (!window) return false;
  const { start, end } = window;
  if (start === end) return false;
  if (start < end) {
    return nowTimeOfDay >= start && nowTimeOfDay < end;
  }
  // Overnight window: quiet from `start` through midnight, then from
  // midnight through `end` the next calendar day.
  return nowTimeOfDay >= start || nowTimeOfDay < end;
}

/** The UTC offset (in minutes, UTC = local - offset) `timeZone` is at for `date`. */
function getOffsetMinutes(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
    .formatToParts(date)
    .reduce<Record<string, string>>((acc, p) => {
      acc[p.type] = p.value;
      return acc;
    }, {});

  // Midnight in some zones formats hour as "24" with hour12: false in some
  // engines — normalize it back to 0 before building the UTC timestamp.
  const hour = parts.hour === "24" ? 0 : Number(parts.hour);
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), hour, Number(parts.minute), Number(parts.second));
  return (asUtc - date.getTime()) / 60_000;
}

/**
 * Converts a "YYYY-MM-DD" date key + "HH:MM" time-of-day, both meant as
 * wall-clock local time in `timeZone`, into the actual UTC Date instant
 * they refer to. Used to turn "quiet hours end at 07:00" into a real,
 * comparable timestamp rather than just a time-of-day string. Two passes:
 * the first UTC guess is corrected by that guess's own offset, then
 * re-checked once more so a DST transition landing exactly inside the
 * lookup can't leave the result off by the transition's delta.
 */
export function zonedTimeToUtc(dateKey: string, timeOfDay: string, timeZone: string): Date {
  const [year, month, day] = dateKey.split("-").map(Number) as [number, number, number];
  const [hour, minute] = timeOfDay.split(":").map(Number) as [number, number];
  const utcGuessMs = Date.UTC(year, month - 1, day, hour, minute, 0);

  let offsetMin = getOffsetMinutes(new Date(utcGuessMs), timeZone);
  let resultMs = utcGuessMs - offsetMin * 60_000;
  const offsetMin2 = getOffsetMinutes(new Date(resultMs), timeZone);
  if (offsetMin2 !== offsetMin) {
    resultMs = utcGuessMs - offsetMin2 * 60_000;
  }
  return new Date(resultMs);
}

/**
 * The real Date a currently-active quiet-hours window ends at, given
 * `now`. Only meaningful when `isQuietHours(formatTimeOfDay(now, timeZone), window)`
 * is already true — this is what a suppressed notification is "queued"
 * until: the scheduler doesn't need to compute or store this itself (see
 * index.ts's reminder/automation-rule loops, which simply leave the item
 * unmarked-notified so the next non-quiet tick sends it), but it's what
 * makes that behavior testable with a concrete timestamp instead of "some
 * later tick, eventually."
 */
export function quietHoursEndAt(now: Date, timeZone: string, window: QuietHoursWindow): Date {
  const todayKey = formatDateKey(now, timeZone);
  const nowTimeOfDay = formatTimeOfDay(now, timeZone);

  // Overnight window (start > end): if we're currently in the
  // before-midnight portion (now >= start), the end time falls on
  // tomorrow's calendar date, not today's.
  let endDateKey = todayKey;
  if (window.start > window.end && nowTimeOfDay >= window.start) {
    const tomorrow = new Date(zonedTimeToUtc(todayKey, "00:00", timeZone).getTime() + 24 * 60 * 60 * 1000);
    endDateKey = formatDateKey(tomorrow, timeZone);
  }

  return zonedTimeToUtc(endDateKey, window.end, timeZone);
}
