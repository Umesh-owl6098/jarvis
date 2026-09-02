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

/** Checkpoint 22 fix — every check is scoped to ONE session's own pending state; a different session's simultaneously-active pending action is invisible here. */
export function activePendingCapabilities(sessionId: string): PendingCapability[] {
  const result: PendingCapability[] = [];
  if (calendarPendingActionStore.active(sessionId)) result.push('calendar');
  if (pendingActionStore.active(sessionId)) result.push('gmail');
  if (tasksPendingActionStore.active(sessionId)) result.push('tasks');
  return result;
}

export function clearPending(sessionId: string, capability: PendingCapability): void {
  if (capability === 'calendar') calendarPendingActionStore.clear(sessionId);
  else if (capability === 'gmail') pendingActionStore.clear(sessionId);
  else tasksPendingActionStore.clear(sessionId);
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

/**
 * Checkpoint 26 — the CONFIRM analogue of describeAmbiguousCancel above.
 * A workflow (e.g. "Schedule a meeting tomorrow and create a task to
 * prepare.") can leave a Calendar proposal AND a Tasks proposal pending
 * simultaneously — a bare "Confirm"/"yes"/"go ahead" must never guess
 * which one to execute; the pre-existing ambiguous-confirm tier
 * (task-manager.ts) already correctly withholds action when 2+ are
 * active, but previously fell through silently with no clarification at
 * all — asymmetric with the cancel side, which has always explained
 * itself. Named CONCEPT nouns ("the calendar event or the task") so the
 * follow-up "Confirm the meeting."/"Confirm the task." (see each
 * capability's own isXSpecificConfirmPhrase) reads naturally as the answer.
 */
export function describeAmbiguousConfirm(active: PendingCapability[]): string {
  const names = active.map((c) => (c === 'calendar' ? 'the calendar event' : c === 'gmail' ? 'the email' : 'the task'));
  const list = names.length === 2 ? names.join(' or ') : `${names.slice(0, -1).join(', ')}, or ${names[names.length - 1]}`;
  return `I have multiple things ready for confirmation. Do you want to confirm ${list}?`;
}
