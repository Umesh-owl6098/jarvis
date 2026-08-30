/**
 * Checkpoint 21 fix — cross-capability pending-action coordination for
 * cancellation. Orchestration Pattern 3 can legitimately leave a Calendar
 * proposal AND a Gmail draft pending at the same time — something no
 * single-capability flow could ever produce before this checkpoint — so
 * the existing "exactly one store active" tiebreak (still used for
 * confirm/reject of SHARED bare vocabulary like "yes"/"no"/"cancel") is no
 * longer sufficient on its own: it can clear a lone pending action, but it
 * can never resolve which ONE of two simultaneously-active pendings a bare
 * word meant. This module adds the missing piece — deliberately NOT a new
 * orchestration/run-ID system: each capability already allows at most one
 * pending action at a time (each store's `.set()` overwrites), so knowing
 * WHICH capability is enough to know WHICH pending action; no additional
 * correlation id is needed.
 */

import { pendingActionStore } from '@/core/capabilities/gmail/pending-action';
import { calendarPendingActionStore } from '@/core/capabilities/calendar/pending-action';
import { tasksPendingActionStore } from '@/core/capabilities/tasks/pending-action';

export type PendingCapability = 'calendar' | 'gmail' | 'tasks';

const LABEL: Record<PendingCapability, string> = { calendar: 'Calendar', gmail: 'Gmail', tasks: 'Tasks' };

export function activePendingCapabilities(): PendingCapability[] {
  const result: PendingCapability[] = [];
  if (calendarPendingActionStore.active()) result.push('calendar');
  if (pendingActionStore.active()) result.push('gmail');
  if (tasksPendingActionStore.active()) result.push('tasks');
  return result;
}

export function clearPending(capability: PendingCapability): void {
  if (capability === 'calendar') calendarPendingActionStore.clear();
  else if (capability === 'gmail') pendingActionStore.clear();
  else tasksPendingActionStore.clear();
}

/** "Cancel both." / "Cancel all." / "Never mind, cancel everything." — clears every currently-active pending action, never guesses at a subset. */
export function isCancelAllPhrase(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/[.,!?]+$/, '');
  return /^(cancel (both|all|everything)|never mind,? cancel everything|no,? cancel (both|all|everything))$/.test(t);
}

/** A short, honest clarification message for a bare "cancel"/"no" with 2+ pending actions active — names what's pending, asks which, cancels nothing. */
export function describeAmbiguousCancel(active: PendingCapability[]): string {
  const list = active.map((c) => `a pending ${LABEL[c]} action`).join(' and ');
  return `I have ${list}. Which should I cancel? (Or say "cancel both"/"cancel all".)`;
}
