/**
 * Checkpoint 28 — the shared, PURE deterministic attention classifier.
 * Extracted from Checkpoint 27's own briefing/runner.ts (`buildAttention`)
 * so both checkpoints rank from ONE algorithm rather than two competing
 * ones — see the architecture report for the extraction rationale.
 *
 * Pure function: no I/O, no capability imports, no clock reads other than
 * the `now` passed in by the caller. No sentiment analysis, no embeddings,
 * no LLM importance scoring, no inferred relationships (e.g. guessing a
 * sender is a VIP) — every rule here is a plain, explainable comparison on
 * already-safe structured metadata.
 */

import type { BriefingCalendarEventView, BriefingTaskView, BriefingMailView } from '../briefing/types';
import type { AttentionSignal } from './types';

/** A meeting counts as "starting soon" (Tier 1 / urgent) within this window. Reused by both Checkpoint 27 and 28 — the ONE definition of "soon" for a meeting, regardless of how far out the caller's own fetch window looked. */
export const MEETING_SOON_MINUTES = 60;

/** Checkpoint 28's "soon" query window (distinct from MEETING_SOON_MINUTES — that's the per-meeting URGENCY threshold; this is how far AHEAD a "soon" scoped query looks at all, i.e. the outer fetch bound). No prior convention existed for this in the codebase, so it's introduced fresh here. */
export const SOON_WINDOW_MINUTES = 240;

export interface AttentionEngineInput {
  calendarEvents: BriefingCalendarEventView[];
  tasksOverdue: BriefingTaskView[];
  tasksDueInScope: BriefingTaskView[];
  gmailUnread: BriefingMailView[];
}

/**
 * Deterministic, explainable ranking — identical tier/ordering discipline
 * Checkpoint 27 already established:
 *   Tier 1 — overdue tasks (most-overdue-first, alphabetical tie-break),
 *            then meetings starting within `soonMinutes` of `now`.
 *   Tier 2 — tasks due within the caller's scope (alphabetical), then
 *            unread recent Gmail (most-recent-first). Read (non-unread)
 *            Gmail is never a signal at all — deliberately preserved from
 *            Checkpoint 27, not manufactured just to populate a list.
 *   Tier 3 — later meetings (not "starting soon"), start-time ascending.
 */
export function rankAttentionSignals(
  input: AttentionEngineInput,
  now: Date,
  soonMinutes: number = MEETING_SOON_MINUTES
): AttentionSignal[] {
  const signals: AttentionSignal[] = [];

  // Tier 1a — overdue tasks.
  const overdueSorted = [...input.tasksOverdue].sort((a, b) => {
    const byDue = (a.due ?? '').localeCompare(b.due ?? '');
    return byDue !== 0 ? byDue : a.title.localeCompare(b.title);
  });
  for (const t of overdueSorted) {
    signals.push({ source: 'tasks', reason: 'task_overdue', tier: 1, id: t.id, taskListId: t.taskListId, label: t.title, timestamp: t.due });
  }

  // Tier 1b — meetings starting within soonMinutes of `now`, start-time
  // ascending. Sorted explicitly here rather than assumed from the
  // caller's own array order — fetchCalendarData() happens to already
  // return events pre-sorted, but this pure function shouldn't silently
  // depend on that undocumented caller behavior to stay correct.
  const soonCutoff = now.getTime() + soonMinutes * 60000;
  const soonMeetings = input.calendarEvents
    .filter((e) => {
      const start = new Date(e.start).getTime();
      return start >= now.getTime() && start <= soonCutoff;
    })
    .sort((a, b) => (a.start < b.start ? -1 : 1));
  for (const e of soonMeetings) {
    signals.push({ source: 'calendar', reason: 'meeting_soon', tier: 1, id: e.id, label: e.title, timestamp: e.start });
  }

  // Tier 2a — tasks due within scope (alphabetical tie-break — same due window already).
  const dueSorted = [...input.tasksDueInScope].sort((a, b) => a.title.localeCompare(b.title));
  for (const t of dueSorted) {
    signals.push({ source: 'tasks', reason: 'task_due', tier: 2, id: t.id, taskListId: t.taskListId, label: t.title, timestamp: t.due });
  }

  // Tier 2b — unread recent email, most recent first.
  const unreadSorted = [...input.gmailUnread].sort((a, b) => (a.date < b.date ? 1 : -1));
  for (const m of unreadSorted) {
    signals.push({ source: 'gmail', reason: 'unread_mail', tier: 2, id: m.id, label: `${m.subject} — ${m.from}`, timestamp: m.date });
  }

  // Tier 3 — later meetings (not "starting soon"), start-time ascending.
  const laterMeetings = input.calendarEvents
    .filter((e) => new Date(e.start).getTime() > soonCutoff)
    .sort((a, b) => (a.start < b.start ? -1 : 1));
  for (const e of laterMeetings) {
    signals.push({ source: 'calendar', reason: 'meeting_upcoming', tier: 3, id: e.id, label: e.title, timestamp: e.start });
  }

  return signals;
}
