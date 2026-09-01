/**
 * Checkpoint 24 — a small, session-scoped "pending conversational slot"
 * store. Deliberately NOT general memory, NOT a database, NOT an
 * unrestricted conversational state machine: it records the ONE typed
 * missing-field question JARVIS just asked the user, so their very next
 * raw turn can answer it without repeating the whole command.
 *
 * Architecturally a sibling of conversation-context.ts (same Map<sessionId,
 * T>/TTL/clear discipline, same CONTEXT_TTL_MS window), but a distinct
 * concept: conversation-context.ts remembers facts ABOUT a completed turn
 * for later pronoun/date reference; this store remembers that JARVIS is
 * mid-question and is WAITING for one specific answer. At most one active
 * slot per session — a second "needs one more field" outcome simply
 * overwrites whatever was pending before.
 *
 * Critical safety invariant (do not weaken): a pending slot is NOT
 * authorization. Filling a missing field only ever lets a capability build
 * the proposal/draft it already builds today for a fully-specified command
 * — it never bypasses that capability's own separate confirmation gate
 * (gmail send / calendar create-update-delete / tasks create-update-
 * complete-delete all still require their own explicit "yes"/"send it"/
 * "create it").
 *
 * Process-local, in-memory only — never written to
 * .jarvis-preferences.json or any other file. A server restart, a new
 * session, or a reloaded tab all start with nothing pending, exactly like
 * conversation-context.ts.
 */

export interface GmailDraftBodySlot {
  kind: 'gmail_draft_body';
  /** Already-resolved recipient address(es) — never a name hint; a slot is only ever created once resolvePerson() (or an explicit email) has produced a concrete address. */
  recipients: string[];
  cc?: string[];
  subject?: string;
  createdAt: number;
}

export interface CalendarDatetimeSlot {
  kind: 'calendar_datetime';
  /** Already-resolved attendee address(es), possibly empty if the original command named no one. */
  attendees: string[];
  title: string;
  /** Set only when the ORIGINAL command stated an explicit duration ("a 45 minute meeting") that must survive into the completed proposal; otherwise left unset so the existing stored-preference/default logic applies fresh, exactly as it would for a one-shot command. */
  durationMinutes?: number;
  createdAt: number;
}

export type PendingConversationSlot = GmailDraftBodySlot | CalendarDatetimeSlot;

const PENDING_SLOT_TTL_MS = 10 * 60 * 1000; // matches conversation-context.ts's CONTEXT_TTL_MS

class PendingSlotStore {
  private sessions = new Map<string, PendingConversationSlot>();

  /** Records the ONE outstanding missing-field question for this session, replacing any prior one. */
  set(sessionId: string, slot: PendingConversationSlot): void {
    this.sessions.set(sessionId, slot);
  }

  /** The active, non-expired slot for this session, or null — an expired slot is pruned as a side effect, never resolved silently past its TTL, and never visible to a different session. */
  active(sessionId: string): PendingConversationSlot | null {
    const slot = this.sessions.get(sessionId);
    if (!slot) return null;
    if (Date.now() - slot.createdAt > PENDING_SLOT_TTL_MS) {
      this.sessions.delete(sessionId);
      return null;
    }
    return slot;
  }

  /** Cleared on successful completion, explicit cancellation, or "Start over." */
  clear(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /** Deterministic cleanup across every session — safe to call on every request, mirrors conversation-context.ts's pruneAllExpired(). */
  pruneAllExpired(): void {
    const cutoff = Date.now() - PENDING_SLOT_TTL_MS;
    for (const [sessionId, slot] of this.sessions) {
      if (slot.createdAt < cutoff) this.sessions.delete(sessionId);
    }
  }

  /** Number of sessions currently holding a pending slot — test/debug only. */
  get sessionCount(): number {
    return this.sessions.size;
  }

  /**
   * TEST-ONLY — directly injects a slot with an explicit `createdAt` (e.g.
   * already past the TTL) so expiry can be verified deterministically
   * without waiting out the real 10-minute window. Not reachable from any
   * user-facing text/command; only test files import and call this.
   */
  __setForTesting(sessionId: string, slot: PendingConversationSlot): void {
    this.sessions.set(sessionId, slot);
  }
}

export const pendingSlotStore = new PendingSlotStore();
