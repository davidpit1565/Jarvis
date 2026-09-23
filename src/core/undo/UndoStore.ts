import type { ReminderRecurrence } from "@/types/reminders";
import type { MemoryCategory, MemoryImportance, MemoryTrust } from "@/types/memory";

export interface UndoableCalendarEventCreation {
  type: "calendar_event_created";
  eventId: string;
  summary: string;
}

export interface UndoableCalendarEventDeletion {
  type: "calendar_event_deleted";
  summary: string;
  start: string;
  end: string;
  location: string | null;
  /**
   * Which linked Google account (its email) the deleted event belonged
   * to. Undoing this recreates the event via createEvent(), which has no
   * event id to resolve the account from (unlike undoing a create/update,
   * which can look the still-valid id up across every linked account) —
   * without this, a multi-account setup would recreate the event on
   * whichever account happens to be primary, silently landing it on the
   * wrong calendar.
   */
  account: string;
}

export interface UndoableCalendarEventUpdate {
  type: "calendar_event_updated";
  eventId: string;
  /** The event's field values right before the update, to restore on undo. */
  previous: { summary: string; start: string; end: string; location: string | null };
}

export interface UndoableReminderDeletion {
  type: "reminder_deleted";
  text: string;
  dueAt: string | null;
  recurrence: ReminderRecurrence | null;
}

export interface UndoableMemoryDeletion {
  type: "memory_deleted";
  key: string;
  value: string;
  /** The deleted record's own category/importance/expiresAt/source, so undoing a delete restores it exactly rather than re-inserting it with defaults (e.g. turning an expiring "temporary" fact permanent, or a low-trust fact into a USER_STATED one). */
  category: MemoryCategory;
  importance: MemoryImportance;
  expiresAt: string | null;
  source: MemoryTrust;
}

export type UndoableAction =
  | UndoableCalendarEventCreation
  | UndoableCalendarEventDeletion
  | UndoableCalendarEventUpdate
  | UndoableReminderDeletion
  | UndoableMemoryDeletion;

/**
 * Tracks exactly one undoable action — the most recent one — so "undo
 * that" has something concrete to reverse. In-memory only, like
 * PermissionService's grants: a single-user personal assistant doesn't
 * need this to survive a restart, and losing it just means "undo" says
 * there's nothing to undo, never that it undoes the wrong thing.
 * Recording a new action always replaces whatever was there — there's
 * only ever "the last thing," not a history to walk back through.
 */
export class UndoStore {
  private lastAction: UndoableAction | undefined;

  record(action: UndoableAction): void {
    this.lastAction = action;
  }

  /** Returns and clears the last action, so undoing it twice in a row does nothing the second time. */
  takeLast(): UndoableAction | undefined {
    const action = this.lastAction;
    this.lastAction = undefined;
    return action;
  }
}
