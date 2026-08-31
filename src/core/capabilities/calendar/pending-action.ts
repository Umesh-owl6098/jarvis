/**
 * Checkpoint 18 §10 — CalendarPendingActionStore. A separate store from
 * Gmail's own pendingActionStore (gmail/pending-action.ts) — deliberately,
 * so a pending email send and a pending calendar mutation can never
 * silently clobber each other. Checkpoint 22 fix — keyed by `sessionId`,
 * same reasoning and same shape as gmail/pending-action.ts's own fix: an
 * un-keyed single slot let one browser session claim/cancel another's
 * pending Calendar action (proven empirically), so every operation now
 * requires an explicit sessionId with no un-keyed fallback.
 *
 * Current model: process-local storage, session-isolated logical state —
 * see gmail/pending-action.ts's own module comment for the full reload/
 * restart/reuse lifecycle notes, which apply identically here. This is
 * session isolation, not authentication or multi-user authorization.
 */

import type { CalendarProposal } from './types';

export type CalendarPendingActionType = 'calendar_create' | 'calendar_update' | 'calendar_delete';

export interface CalendarPendingAction {
  type: CalendarPendingActionType;
  proposal: CalendarProposal;
  createdAt: number;
  expiresAt: number;
  consumed: boolean;
}

const PENDING_ACTION_TTL_MS = 5 * 60 * 1000; // same 5-minute window as Gmail's

export class CalendarPendingActionStore {
  private sessions = new Map<string, CalendarPendingAction>();

  set(sessionId: string, action: Omit<CalendarPendingAction, 'expiresAt' | 'consumed'>): CalendarPendingAction {
    const full: CalendarPendingAction = { ...action, expiresAt: action.createdAt + PENDING_ACTION_TTL_MS, consumed: false };
    this.sessions.set(sessionId, full);
    return full;
  }

  active(sessionId: string): CalendarPendingAction | null {
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

  /** §16 — atomically claims the pending action, exactly like Gmail's claim(): a racing second confirmation sees nothing left to claim. */
  claim(sessionId: string): CalendarPendingAction | null {
    const action = this.active(sessionId);
    if (!action) return null;
    action.consumed = true;
    return action;
  }

  clear(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /** Deterministic cleanup — removes every session whose pending action has expired or been consumed, so the map cannot grow forever. */
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

export const calendarPendingActionStore = new CalendarPendingActionStore();
