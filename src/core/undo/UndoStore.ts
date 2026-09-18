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
}

export type UndoableAction = UndoableCalendarEventCreation | UndoableCalendarEventDeletion;

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
