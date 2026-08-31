/**
 * Checkpoint 20 §10 — TasksPendingActionStore. A separate store from
 * Gmail's and Calendar's own stores (same reasoning as
 * calendar/pending-action.ts's own separation from Gmail's). Checkpoint 22
 * fix — keyed by `sessionId`, same reasoning and same shape as the Gmail
 * and Calendar stores' own fix: every operation now requires an explicit
 * sessionId, no un-keyed fallback.
 *
 * Current model: process-local storage, session-isolated logical state —
 * see gmail/pending-action.ts's own module comment for the full reload/
 * restart/reuse lifecycle notes, which apply identically here. This is
 * session isolation, not authentication or multi-user authorization.
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
  private sessions = new Map<string, TasksPendingAction>();

  set(sessionId: string, action: Omit<TasksPendingAction, 'expiresAt' | 'consumed'>): TasksPendingAction {
    const full: TasksPendingAction = { ...action, expiresAt: action.createdAt + PENDING_ACTION_TTL_MS, consumed: false };
    this.sessions.set(sessionId, full);
    return full;
  }

  active(sessionId: string): TasksPendingAction | null {
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

  /** Atomically claims the pending action — a racing second confirmation sees nothing left to claim. */
  claim(sessionId: string): TasksPendingAction | null {
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

export const tasksPendingActionStore = new TasksPendingActionStore();
