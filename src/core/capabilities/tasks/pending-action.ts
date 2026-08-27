/**
 * Checkpoint 20 §10 — TasksPendingActionStore. A separate store from
 * Gmail's and Calendar's own stores (same reasoning as
 * calendar/pending-action.ts's own separation from Gmail's) — one slot per
 * capability so a pending email send, a pending calendar mutation, and a
 * pending task mutation can never silently clobber each other. Same
 * shape/TTL/claim semantics as both.
 */

import type { TaskProposal } from './types';

export type TasksPendingActionType = 'tasks_create' | 'tasks_update' | 'tasks_complete' | 'tasks_delete';

export interface TasksPendingAction {
  type: TasksPendingActionType;
  proposal: TaskProposal;
  createdAt: number;
  expiresAt: number;
  consumed: boolean;
}

const PENDING_ACTION_TTL_MS = 5 * 60 * 1000; // same 5-minute window as Gmail's/Calendar's

export class TasksPendingActionStore {
  private current: TasksPendingAction | null = null;

  set(action: Omit<TasksPendingAction, 'expiresAt' | 'consumed'>): TasksPendingAction {
    const full: TasksPendingAction = { ...action, expiresAt: action.createdAt + PENDING_ACTION_TTL_MS, consumed: false };
    this.current = full;
    return full;
  }

  active(): TasksPendingAction | null {
    if (!this.current) return null;
    if (this.current.consumed) return null;
    if (Date.now() > this.current.expiresAt) {
      this.current = null;
      return null;
    }
    return this.current;
  }

  /** Atomically claims the pending action — a racing second confirmation sees nothing left to claim. */
  claim(): TasksPendingAction | null {
    const action = this.active();
    if (!action) return null;
    action.consumed = true;
    return action;
  }

  clear(): void {
    this.current = null;
  }
}

export const tasksPendingActionStore = new TasksPendingActionStore();
