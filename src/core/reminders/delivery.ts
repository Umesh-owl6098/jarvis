/**
 * Checkpoint 29 §10, HOLD-revised — the reminder delivery surface: safe,
 * display-only records of reminders that have fired, for the UI to poll
 * and show. Originally an in-memory queue; replaced (HOLD audit) with a
 * thin function over reminderStore's own persisted `surfacedAt` field —
 * see store.ts's drainUnsurfaced() for the actual durability mechanism.
 * This module exists only to keep the "what does a UI poll receive"
 * concern in one small, clearly-named place — it holds no state of its
 * own.
 *
 * CRITICAL invariant (§10/§12): nothing in this module — or anywhere else
 * reachable from a fired reminder — ever feeds reminder.text into the
 * task runner as a command, touches any Gmail/Calendar/Tasks client,
 * invokes the browser or the router client, or reads a pending-action/
 * pending-slot/preferences store. A delivery record is inert display
 * data, full stop. drainDueDeliveries() below performs exactly one
 * action — a persisted status-field transition on already-delivered
 * reminders — and nothing else; it never scans Gmail/Calendar/Tasks and
 * never interprets reminder text.
 */

import { reminderStore } from './store';
import type { ReminderDelivery } from './types';

/** Atomically surfaces (and returns, as safe display records) every reminder that is delivered but not yet shown to any UI. Called by the polling endpoint; also safe to call from anywhere else that wants an at-most-once "what's newly due" surface. */
export function drainDueDeliveries(now: Date = new Date()): ReminderDelivery[] {
  return reminderStore.drainUnsurfaced(now).map((r) => ({
    reminderId: r.id,
    text: r.text,
    triggerAt: r.triggerAt,
    deliveredAt: r.deliveredAt!,
  }));
}
