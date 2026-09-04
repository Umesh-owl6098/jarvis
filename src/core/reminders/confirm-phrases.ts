/**
 * Checkpoint 29 — Reminder-specific confirm/cancel phrase recognition,
 * mirroring calendar/intent.ts's, tasks/intent.ts's, and gmail/intent.ts's
 * own isXSpecificConfirmPhrase/isXSpecificCancelPhrase/
 * isAmbiguousXConfirmPhrase functions exactly (same bare-word vocabulary,
 * same noun-phrase shape) — kept in the reminders module rather than
 * folded into reminders/intent.ts so the create/list/next/cancel GRAMMAR
 * stays separate from the CONFIRMATION vocabulary, matching how the other
 * three capabilities structure this (their confirm/cancel phrase checkers
 * live alongside the rest of intent.ts, but are logically a distinct
 * concern from "what does a create/list/search command look like").
 *
 * Deliberate collision note: tasks/intent.ts's isTasksSpecificConfirmPhrase
 * / isTasksSpecificCancelPhrase ALSO match "confirm/cancel the reminder"
 * (Tasks has long treated "reminder" as an informal synonym for a Google
 * Task — CP20's own vocabulary choice, unrelated to CP29). task-manager.ts
 * checks THIS module's own reminder-specific tier BEFORE Tasks' tier, and
 * only fires when reminderPendingActionStore actually has something
 * active for this session — so "Confirm the reminder" resolves to CP29's
 * new scheduled reminder whenever one is genuinely pending, and falls
 * through unchanged to Tasks' own pre-existing behavior otherwise (a
 * pending Google Task the user informally calls "the reminder").
 */

/** Ambiguous bare confirmations — only ever consulted by task-manager.ts when a non-expired reminder pending action already exists. Identical wording to every other capability's own version (calendar/tasks/gmail) — each capability owns its own copy by established convention, not shared, so each can evolve independently. */
export function isAmbiguousReminderConfirmPhrase(text: string): boolean {
  const t = text.trim().toLowerCase();
  return /^(confirm(ed)?|go ahead|yes)\.?!?$/.test(t);
}

/** Explicit rejection — deliberately NOT the bare word "cancel" alone in isolation from context (matches calendar's/tasks'/gmail's own reject vocabulary exactly). */
export function isReminderRejectPhrase(text: string): boolean {
  const t = text.trim().toLowerCase();
  return /^(no|don'?t (?:do (?:that|it)|create it|set it)|cancel( it| that)?|never mind|abort|stop)\.?!?$/.test(t);
}

/** "Confirm the reminder." — names the capability specifically, safe to act on regardless of what else is pending (dispatches to whatever type — create or cancel — is ACTUALLY stored, mirroring the other three capabilities' own type-agnostic specific-confirm phrase). */
export function isReminderSpecificConfirmPhrase(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/[.,!?]+$/, '');
  return /^confirm the reminder$/.test(t);
}

/** "Cancel the reminder."/"Don't set the reminder." — Reminder-specific cancel phrase. */
export function isReminderSpecificCancelPhrase(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/[.,!?]+$/, '');
  return /^(cancel|don'?t (?:create|set)) the reminder$/.test(t);
}
