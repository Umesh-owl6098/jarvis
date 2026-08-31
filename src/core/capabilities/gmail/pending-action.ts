/**
 * Checkpoint 17 §10 — PendingActionStore. Checkpoint 22 fix — keyed by
 * `sessionId` (one opaque id per browser tab/UI session — see
 * src/core/agent/session.ts). Originally this was a single in-memory slot
 * shared by the whole process ("JARVIS is a single-user local app"), but an
 * empirical cross-session test proved that assumption wrong the moment two
 * independent UI sessions hit the same dev-server process: session B could
 * claim/cancel/inherit session A's pending send. Every operation now
 * requires an explicit sessionId — there is no un-keyed fallback — so a
 * caller that doesn't know its own session id cannot accidentally read or
 * mutate another session's state.
 *
 * Current model: process-local storage, session-isolated logical state.
 * The underlying Map lives in this one Node process's memory (not a
 * database, not shared across processes) — but every entry is keyed by
 * sessionId, so no two sessions can read or write each other's entry.
 * Concretely:
 *   - a page reload mints a NEW session id by design (see page.tsx) — the
 *     old session's pending action becomes orphaned, never migrated, and
 *     still expires through its own normal TTL below;
 *   - a server restart clears every session's state, same as the
 *     pre-existing no-database design;
 *   - a caller that wants multi-turn behavior must keep sending the SAME
 *     sessionId on every request.
 * This is session isolation, not authentication or multi-user
 * authorization — a sessionId is an opaque conversation handle, not a
 * verified identity, and grants no permission checks of its own.
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
  private sessions = new Map<string, PendingAction>();

  set(sessionId: string, action: Omit<PendingAction, 'expiresAt' | 'consumed'>): PendingAction {
    const full: PendingAction = { ...action, expiresAt: action.createdAt + PENDING_ACTION_TTL_MS, consumed: false };
    this.sessions.set(sessionId, full);
    return full;
  }

  /** Returns the pending action only if it exists, hasn't expired, and hasn't already been consumed — every caller must go through this, never read the map directly. */
  active(sessionId: string): PendingAction | null {
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

  /** §16 — atomically claims the pending action for sending. Returns null if it's already gone/expired/consumed (a racing second confirmation), otherwise marks it consumed and returns it exactly once. */
  claim(sessionId: string): PendingAction | null {
    const action = this.active(sessionId);
    if (!action) return null;
    action.consumed = true;
    return action;
  }

  clear(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /** Deterministic cleanup — removes every session whose pending action has expired or been consumed, so the map cannot grow forever. Safe to call anytime; never removes a live, unexpired pending action. */
  pruneExpired(): void {
    const now = Date.now();
    for (const [sessionId, action] of this.sessions) {
      if (action.consumed || now > action.expiresAt) this.sessions.delete(sessionId);
    }
  }

  /** Number of sessions currently holding a (possibly expired) entry — test/debug only. */
  get sessionCount(): number {
    return this.sessions.size;
  }
}

export const pendingActionStore = new PendingActionStore();
