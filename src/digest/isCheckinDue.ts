const HOUR_MS = 60 * 60 * 1000;

/**
 * Pure matching logic for the wellness check-in, kept separate from the
 * scheduler's setInterval/network code so it's unit-testable without
 * timers. Due once the gap since the last interaction (any channel)
 * reaches the configured threshold, and not fired again until a new
 * interaction happens — `alreadySentSinceLastInteraction` is how the
 * caller avoids re-sending on every tick once it's already due.
 */
export function isCheckinDue(
  now: Date,
  lastInteractionAt: Date,
  checkinAfterHours: number,
  alreadySentSinceLastInteraction: boolean
): boolean {
  if (alreadySentSinceLastInteraction) return false;
  return now.getTime() - lastInteractionAt.getTime() >= checkinAfterHours * HOUR_MS;
}
