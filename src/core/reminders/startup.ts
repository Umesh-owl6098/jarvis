/**
 * Checkpoint 29 §9 — server-startup reminder recovery. Called once, from
 * src/instrumentation.ts's register() hook (Next.js App Router's own
 * sanctioned "run once when a new server instance starts" mechanism — see
 * the CP29 architecture report for why this, rather than a module-level
 * side effect, is the right place: it survives dev-mode HMR module
 * reloads correctly, since register() itself is only ever called once per
 * real server instance, not once per module re-evaluation).
 *
 * Deterministic overdue semantics: any reminder still 'scheduled' whose
 * triggerAt is already at-or-before `now` is marked 'delivered' via the
 * SAME atomic reminderStore.markAllDueDelivered() the scheduler's own
 * fire() uses — one shared implementation, not two. This is what makes
 * restart-recovery exactly-once-DELIVERED at the process level: the fact
 * of delivery is the persisted status transition itself, not anything
 * held in memory, so a SECOND restart before the reminder is ever read
 * never re-delivers it (its status is already 'delivered',
 * markAllDueDelivered only ever touches 'scheduled' reminders). This is
 * single-process local exactly-once semantics, not distributed
 * exactly-once delivery.
 *
 * HOLD fix — this function deliberately does NOT also try to re-surface
 * anything. "Surfaced" (shown to a UI) is now its own durable, persisted
 * fact (Reminder.surfacedAt, via reminderStore.drainUnsurfaced() — see
 * delivery.ts), reconstructed automatically by the NEXT poll of
 * /api/reminders/due regardless of how many restarts happened first —
 * there is nothing for startup to "recover" on that side, because nothing
 * about it ever lived only in memory to begin with.
 */

import { reminderStore } from './store';
import { rearmScheduler } from './scheduler';

export function recoverOverdueRemindersOnStartup(now: Date = new Date()): void {
  reminderStore.markAllDueDelivered(now);
  rearmScheduler(now);
}
