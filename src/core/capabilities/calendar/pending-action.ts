/**
 * Checkpoint 18 §10 — CalendarPendingActionStore. A separate store from
 * Gmail's own pendingActionStore (gmail/pending-action.ts), not a shared
 * singleton — deliberately, so a pending email send and a pending calendar
 * mutation can never silently clobber each other (one slot each, same
 * single-user-app reasoning Gmail's store already uses, just not merged
 * across two unrelated capabilities). Same shape/TTL/claim semantics.
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
  private current: CalendarPendingAction | null = null;

  set(action: Omit<CalendarPendingAction, 'expiresAt' | 'consumed'>): CalendarPendingAction {
    const full: CalendarPendingAction = { ...action, expiresAt: action.createdAt + PENDING_ACTION_TTL_MS, consumed: false };
    this.current = full;
    return full;
  }

  active(): CalendarPendingAction | null {
    if (!this.current) return null;
    if (this.current.consumed) return null;
    if (Date.now() > this.current.expiresAt) {
      this.current = null;
      return null;
    }
    return this.current;
  }

  /** §16 — atomically claims the pending action, exactly like Gmail's claim(): a racing second confirmation sees nothing left to claim. */
  claim(): CalendarPendingAction | null {
    const action = this.active();
    if (!action) return null;
    action.consumed = true;
    return action;
  }

  clear(): void {
    this.current = null;
  }
}

export const calendarPendingActionStore = new CalendarPendingActionStore();
