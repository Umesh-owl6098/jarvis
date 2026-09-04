/**
 * Checkpoint 28 — normalized attention-signal shapes. Deliberately flat and
 * small: every field here is either already-safe display data (a title/
 * subject/sender string) or a bare ISO timestamp — never a Gmail body/
 * snippet, Calendar description, Task notes, or a raw capability API
 * object. Reuses Checkpoint 27's own safe VIEW types (BriefingCalendarEventView/
 * BriefingTaskView/BriefingMailView) as its INPUT rather than redefining
 * them — those are already privacy-projected at the point they're built.
 */

export type AttentionSource = 'calendar' | 'tasks' | 'gmail';

export type AttentionReason =
  | 'task_overdue'
  | 'task_due'
  | 'meeting_soon'
  | 'meeting_upcoming'
  | 'unread_mail';

export type AttentionTier = 1 | 2 | 3;

export interface AttentionSignal {
  source: AttentionSource;
  reason: AttentionReason;
  tier: AttentionTier;
  id: string;
  /** Tasks only — Google Tasks addresses a task by (taskListId, id) together. */
  taskListId?: string;
  /** The safe raw item name: task/event title, or "subject — sender" for Gmail. */
  label: string;
  /** ISO — task due date, Calendar event start, or Gmail message date. */
  timestamp?: string;
}

export type AttentionWindowKind = 'right_now' | 'soon' | 'day';

/**
 * How far ahead to look, and what to call it in rendered text. `day` scopes
 * (today/tomorrow/dayparts) reuse Calendar's own existing day/daypart
 * boundary conventions exactly, same as Checkpoint 27's BriefingScope.
 * `tasksDayOffset` is always a whole-day offset — Google Tasks' `due` is
 * date-only, so a sub-day window ("right now"/"soon") has no Tasks
 * equivalent finer than "due today."
 */
export interface AttentionScope {
  kind: AttentionWindowKind;
  label: string;
  rangeStart: string;
  rangeEnd: string;
  tasksDayOffset: number;
}
