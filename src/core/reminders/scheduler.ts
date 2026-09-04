/**
 * Checkpoint 29 §8 — the reminder scheduler. Deliberately the SMALLEST
 * possible process-local mechanism: at most ONE armed setTimeout at any
 * moment, always for the single nearest scheduled reminder — never one
 * timer per reminder, never a repeating/periodic re-check loop, never an
 * OS-level scheduled-job daemon, never launchd, never a service worker,
 * never an external push service. This is exactly the bounded delivery
 * mechanism §8 requires and nothing more.
 *
 * Recomputed (cleared and re-armed from scratch) on every one of the four
 * events §8 names: a reminder is created, cancelled, delivered, or the
 * server starts. `rearmScheduler()` is the single entry point for all
 * four — it is idempotent and always clears any existing timer FIRST, so
 * calling it repeatedly (even concurrently) can never accumulate more
 * than one live timer.
 *
 * HMR safety: Next.js dev-mode module reloads can re-evaluate this file,
 * which would normally orphan a plain module-level `let` timer handle
 * (the OLD module instance's setTimeout keeps ticking in Node's real timer
 * queue, unreachable from the NEW module instance's own fresh `null`
 * variable — see the CP29 architecture report). The timer handle is
 * therefore stashed on `globalThis` instead of a bare module-level
 * variable, so a fresh module evaluation can still find and clear
 * whatever the PREVIOUS instance armed before arming its own.
 *
 * Long-delay safety: Node's setTimeout has a practical maximum delay
 * (2^31-1 ms, ~24.8 days) — passing anything larger silently fires
 * immediately, which would be exactly backwards for a reminder scheduled
 * further out than that. A reminder further away than SAFETY_CHECKPOINT_MS
 * (24 hours, comfortably under that ceiling) is never scheduled directly;
 * instead a bounded checkpoint timer wakes up once a day, performs NO
 * delivery/external action of any kind, and simply recomputes — so an
 * arbitrarily-far-future reminder is never lost and never overflows.
 */

import { reminderStore } from './store';

const SAFETY_CHECKPOINT_MS = 24 * 60 * 60 * 1000; // 24h — comfortably under Node's ~24.8-day setTimeout ceiling

interface SchedulerState {
  timer: ReturnType<typeof setTimeout> | null;
  /** Which reminder id the current timer is armed for, or 'checkpoint' for a bounded far-future wake-up, or null if nothing is armed — observability/testing only, never read by any control-flow decision. */
  armedForId: string | null;
}

declare global {
  // eslint-disable-next-line no-var
  var __jarvisReminderScheduler: SchedulerState | undefined;
}

function state(): SchedulerState {
  if (!globalThis.__jarvisReminderScheduler) {
    globalThis.__jarvisReminderScheduler = { timer: null, armedForId: null };
  }
  return globalThis.__jarvisReminderScheduler;
}

function clearArmedTimer(): void {
  const s = state();
  if (s.timer) {
    clearTimeout(s.timer);
    s.timer = null;
  }
  s.armedForId = null;
}

/**
 * Fires independently of any UI/polling activity — this is the server
 * scheduler's own timer callback, never triggered by an HTTP request. It
 * only ever transitions status 'scheduled' -> 'delivered' (persisted,
 * exactly-once). Whether/when anyone actually SEES that delivery is a
 * completely separate, later concern — reminderStore.drainUnsurfaced(),
 * called only from the polling endpoint (see delivery.ts) — deliberately
 * decoupled so a delivery is never lost merely because nothing polled
 * before a restart (see the HOLD report's own scenario trace).
 */
function fire(): void {
  const now = new Date();
  reminderStore.markAllDueDelivered(now);
  rearmScheduler(new Date());
}

/**
 * Idempotent — always clears any existing timer first, then re-reads
 * persisted state and arms exactly one timer for whatever is nearest NOW.
 * Safe to call from anywhere, any number of times, concurrently — the
 * "clear first" discipline is what makes it impossible to ever end up
 * with two live timers.
 */
export function rearmScheduler(now: Date = new Date()): void {
  clearArmedTimer();
  const scheduled = reminderStore.scheduledSorted();
  if (scheduled.length === 0) return;

  const nearest = scheduled[0];
  const delayMs = new Date(nearest.triggerAt).getTime() - now.getTime();
  const s = state();

  if (delayMs <= 0) {
    // Already due by the time we got here (e.g. a race between two calls,
    // or a reminder created in the past — should not normally happen given
    // §5's past-time rejection, but handled defensively). Fire via a 0ms
    // timer rather than delivering synchronously inline, so rearmScheduler
    // itself never blocks a caller on delivery side effects.
    s.armedForId = nearest.id;
    s.timer = setTimeout(fire, 0);
    s.timer.unref?.();
    return;
  }

  if (delayMs > SAFETY_CHECKPOINT_MS) {
    s.armedForId = 'checkpoint';
    s.timer = setTimeout(() => rearmScheduler(new Date()), SAFETY_CHECKPOINT_MS);
    s.timer.unref?.();
    return;
  }

  s.armedForId = nearest.id;
  s.timer = setTimeout(fire, delayMs);
  // unref() — this timer alone must never keep the Node process alive.
  // In the real server it's harmless (the HTTP listener already keeps the
  // process running); in tests/scripts it lets the process exit naturally
  // once its own explicit work is done, rather than hanging for however
  // far in the future the nearest reminder is.
  s.timer.unref?.();
}

/** Clears any armed timer without re-arming — used for clean test teardown and (optionally) graceful shutdown. Never called as part of normal reminder create/cancel/deliver flow (those always call rearmScheduler, which re-arms). */
export function disarmScheduler(): void {
  clearArmedTimer();
}

/** TEST-ONLY — observability into the scheduler's own armed state, never used by any production control-flow decision. */
export function __schedulerStateForTesting(): { armed: boolean; armedForId: string | null } {
  const s = state();
  return { armed: s.timer !== null, armedForId: s.armedForId };
}
