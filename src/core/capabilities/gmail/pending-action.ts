/**
 * Checkpoint 17 §10 — PendingActionStore. JARVIS is a single-user local
 * app (one dev-server process, one operator — same assumption task-registry.ts
 * already makes) so a single in-memory slot is the right amount of state,
 * not a per-task map: "send it" as a follow-up TURN needs to reference the
 * PREVIOUS turn's pending action, not a fresh one. No database — matches
 * §10's own "no database needed yet."
 */

export type PendingActionType = 'gmail_send';

export interface PendingAction {
  type: PendingActionType;
  draftId: string;
  recipient: string[];
  subject: string;
  createdAt: number;
  expiresAt: number;
  /** §16 idempotency — set the moment send() is actually accepted, before any awaited I/O completes, so a second confirmation racing in behind it sees this immediately. */
  consumed: boolean;
}

const PENDING_ACTION_TTL_MS = 5 * 60 * 1000; // 5 minutes — long enough for a real confirmation turn, short enough that a stale "send it" days later can't fire

export class PendingActionStore {
  private current: PendingAction | null = null;

  set(action: Omit<PendingAction, 'expiresAt' | 'consumed'>): PendingAction {
    const full: PendingAction = { ...action, expiresAt: action.createdAt + PENDING_ACTION_TTL_MS, consumed: false };
    this.current = full;
    return full;
  }

  /** Returns the pending action only if it exists, hasn't expired, and hasn't already been consumed — every caller must go through this, never read `current` directly. */
  active(): PendingAction | null {
    if (!this.current) return null;
    if (this.current.consumed) return null;
    if (Date.now() > this.current.expiresAt) {
      this.current = null;
      return null;
    }
    return this.current;
  }

  /** §16 — atomically claims the pending action for sending. Returns null if it's already gone/expired/consumed (a racing second confirmation), otherwise marks it consumed and returns it exactly once. */
  claim(): PendingAction | null {
    const action = this.active();
    if (!action) return null;
    action.consumed = true;
    return action;
  }

  clear(): void {
    this.current = null;
  }
}

export const pendingActionStore = new PendingActionStore();
