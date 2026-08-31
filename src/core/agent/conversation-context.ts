/**
 * Checkpoint 22 — a small, session-scoped conversation context layer.
 * Deliberately NOT a database, NOT long-term memory, NOT a vector store:
 * a bounded ring buffer of the last few turns' MINIMAL structured facts,
 * held in-memory for this process's lifetime only, with a TTL so a stale
 * reference can never resolve silently.
 *
 * What's stored is deliberately narrow — IDs, normalized metadata, and
 * short labels, never raw personal content:
 *   - which capability/operation the last turn used
 *   - a resolved DATE (days-from-now + label), never a copied description
 *   - a resolved CONTACT reference (the query text + resolved email, or
 *     the fact that it was ambiguous/not-found) — never other contact
 *     fields (org, full candidate list)
 *   - a resolved TARGET entity (kind + id + title only) for a future
 *     "the meeting"/"the task"/"the email" reference — never its body/
 *     notes/description
 *
 * Checkpoint 22 fix — keyed by `sessionId` (one opaque id per browser tab/
 * UI session, see src/core/agent/session.ts). This was originally a single
 * process-wide slot ("session-scoped" in name only); an empirical
 * cross-session test proved a second, entirely independent UI
 * session/request could inherit the first one's "that"/"Friday"/prior date
 * — exactly the leak this checkpoint's keying fixes. Every operation now
 * requires an explicit sessionId, with no un-keyed fallback.
 *
 * Current model: process-local storage, session-isolated logical state.
 * The `sessions` Map below lives in this one Node process's memory (not a
 * database, not shared across processes) — but every entry is keyed by
 * sessionId, so no two sessions can read or write each other's turns.
 * Concretely:
 *   - a page reload mints a NEW session id by design (see page.tsx) — the
 *     old session's context becomes orphaned, never migrated, and still
 *     expires through its own normal TTL below;
 *   - a server restart clears every session's context, same as the
 *     pre-existing no-database design;
 *   - a caller that wants multi-turn follow-ups ("What about Friday?")
 *     must keep sending the SAME sessionId on every request.
 * This is session isolation, not authentication or multi-user
 * authorization — a sessionId is an opaque conversation handle, not a
 * verified identity, and grants no permission checks of its own.
 */

export type ContextCapability = 'calendar' | 'gmail' | 'tasks' | 'orchestration';

export interface ContextDateRef {
  daysFromNow: number;
  label: string;
}

export interface ContextContactRef {
  query: string;
  email?: string;
  ambiguous?: boolean;
}

export interface ContextTargetRef {
  kind: 'event' | 'task' | 'message';
  id: string;
  title: string;
}

export interface ConversationTurn {
  capability: ContextCapability;
  operation: string;
  dateRef?: ContextDateRef;
  contactRef?: ContextContactRef;
  targetRef?: ContextTargetRef;
  createdAt: number;
}

const CONTEXT_TTL_MS = 10 * 60 * 1000; // 10 minutes — longer than any single PendingAction TTL (5 min) so context doesn't expire mid-confirmation-flow, but still bounded, never "forever."
const MAX_HISTORY = 5;

class ConversationContextStore {
  private sessions = new Map<string, ConversationTurn[]>();

  push(sessionId: string, turn: Omit<ConversationTurn, 'createdAt'>): void {
    const turns = this.sessions.get(sessionId) ?? [];
    turns.unshift({ ...turn, createdAt: Date.now() });
    if (turns.length > MAX_HISTORY) turns.length = MAX_HISTORY;
    this.sessions.set(sessionId, turns);
  }

  /** The most recent NON-EXPIRED turn for THIS session, or null — an old "that"/"it"/"them" must never resolve silently past this TTL, and never resolve against a DIFFERENT session's turns. */
  latest(sessionId: string): ConversationTurn | null {
    this.pruneExpiredFor(sessionId);
    return this.sessions.get(sessionId)?.[0] ?? null;
  }

  private pruneExpiredFor(sessionId: string): void {
    const turns = this.sessions.get(sessionId);
    if (!turns) return;
    const cutoff = Date.now() - CONTEXT_TTL_MS;
    const live = turns.filter((t) => t.createdAt >= cutoff);
    if (live.length === 0) this.sessions.delete(sessionId);
    else this.sessions.set(sessionId, live);
  }

  /** "Forget that." / "Start over." — clears ONLY this session's conversational reference state. Never touches real Gmail/Calendar/Tasks data, never another session's context, and deliberately does NOT clear any capability's own PendingAction store (those require their own explicit, separate cancel — see multi-pending.ts). */
  clear(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /** Deterministic cleanup across every session — removes any session whose entire turn history has expired, so the map cannot grow forever. Safe to call on every request; never removes a live, unexpired turn. */
  pruneAllExpired(): void {
    const cutoff = Date.now() - CONTEXT_TTL_MS;
    for (const [sessionId, turns] of this.sessions) {
      const live = turns.filter((t) => t.createdAt >= cutoff);
      if (live.length === 0) this.sessions.delete(sessionId);
      else this.sessions.set(sessionId, live);
    }
  }

  /** Number of sessions currently holding turn history — test/debug only. */
  get sessionCount(): number {
    return this.sessions.size;
  }

  /**
   * TEST-ONLY — directly injects a turn with an explicit `createdAt` (e.g.
   * already past the TTL) so expiry can be verified deterministically
   * without waiting out the real 10-minute window. Not reachable from any
   * user-facing text/command; only test files import and call this.
   */
  __pushForTesting(sessionId: string, turn: ConversationTurn): void {
    const turns = this.sessions.get(sessionId) ?? [];
    turns.unshift(turn);
    if (turns.length > MAX_HISTORY) turns.length = MAX_HISTORY;
    this.sessions.set(sessionId, turns);
  }
}

export const conversationContext = new ConversationContextStore();
