/**
 * Checkpoint 29 — ReminderPendingActionStore. A separate store from Gmail's/
 * Calendar's/Tasks' own (same reasoning as calendar/pending-action.ts's own
 * separation from Gmail's) — a pending reminder creation/cancellation must
 * never clobber or be clobbered by an unrelated pending Calendar/Gmail/
 * Tasks mutation. Session-keyed, same session-isolation discipline as
 * every other pending-action store (see gmail/pending-action.ts's own
 * module comment for the full reload/restart/reuse lifecycle notes).
 *
 * Both creating AND cancelling a reminder are mutations of persisted local
 * state (§6/§7), so both go through this same propose-then-confirm gate —
 * one store, two proposal shapes, exactly mirroring how Calendar's own
 * store holds create/update/delete proposals under one CalendarPendingAction
 * type.
 */

export type ReminderPendingActionType = 'reminder_create' | 'reminder_cancel';

export interface ReminderCreateProposal {
  text: string;
  triggerAt: string; // ISO
  label: string; // human-readable render of triggerAt, computed once at proposal time
}

export interface ReminderCancelProposal {
  reminderId: string;
  text: string;
  triggerAt: string;
  label: string;
}

export interface ReminderPendingAction {
  type: ReminderPendingActionType;
  proposal: ReminderCreateProposal | ReminderCancelProposal;
  createdAt: number;
  expiresAt: number;
  consumed: boolean;
}

const PENDING_ACTION_TTL_MS = 5 * 60 * 1000; // same 5-minute window as Gmail's/Calendar's/Tasks'

export class ReminderPendingActionStore {
  private sessions = new Map<string, ReminderPendingAction>();

  set(sessionId: string, action: Omit<ReminderPendingAction, 'expiresAt' | 'consumed'>): ReminderPendingAction {
    const full: ReminderPendingAction = { ...action, expiresAt: action.createdAt + PENDING_ACTION_TTL_MS, consumed: false };
    this.sessions.set(sessionId, full);
    return full;
  }

  active(sessionId: string): ReminderPendingAction | null {
    const current = this.sessions.get(sessionId);
    if (!current) return null;
    if (current.consumed) {
      this.sessions.delete(sessionId);
      return null;
    }
    if (Date.now() > current.expiresAt) {
      this.sessions.delete(sessionId);
      return null;
    }
    return current;
  }

  /** Atomically claims the pending action — a racing second confirmation sees nothing left to claim, same as every other capability's store. */
  claim(sessionId: string): ReminderPendingAction | null {
    const action = this.active(sessionId);
    if (!action) return null;
    action.consumed = true;
    return action;
  }

  clear(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  pruneExpired(): void {
    const now = Date.now();
    for (const [sessionId, action] of this.sessions) {
      if (action.consumed || now > action.expiresAt) this.sessions.delete(sessionId);
    }
  }

  get sessionCount(): number {
    return this.sessions.size;
  }
}

export const reminderPendingActionStore = new ReminderPendingActionStore();
