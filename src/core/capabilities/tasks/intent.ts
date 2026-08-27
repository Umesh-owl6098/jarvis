/**
 * Checkpoint 20 §5/§7/§13-15 — deterministic Tasks intent parsing. No LLM
 * call to decide WHICH Tasks operation a task names or to extract
 * title/due-date — same discipline as gmail/intent.ts and
 * calendar/intent.ts.
 *
 * §14 — Calendar-vs-Tasks routing is kept collision-free by construction:
 * every Tasks trigger below requires either an explicit "task"/"reminder"
 * word, or the specific "remind me to"/"what do I need to do" phrasing —
 * vocabulary Calendar's own regexes (schedule/meeting/event/appointment/
 * free/busy) never use, and vice versa. See datetime.ts's module comment
 * for why due-date resolution reuses Calendar's resolveDayPhrase directly
 * rather than reimplementing it.
 */

import { resolveDayPhrase, taskDueIso, DEFAULT_TIMEZONE } from './datetime';
import { GMAIL_EMAIL_VERB_RE } from '@/core/capabilities/shared/gmail-guard';
import type { TasksPendingActionType } from './pending-action';

export type TasksOperation = 'list_lists' | 'list' | 'search' | 'propose_create' | 'propose_update' | 'propose_complete' | 'propose_delete';

export interface TasksIntent {
  operation: TasksOperation;
  raw: string;
  timezone: string;
  /** list — due-date filter, when a day was named ("today"/"tomorrow"); absent means "all". */
  dueDay?: string;
  /** search / update / complete / delete target resolution */
  searchQuery?: string;
  /** propose_create / propose_update */
  title?: string;
  due?: string;
  /** Set when date/time genuinely couldn't be resolved for a create that named no day at all — callers must ask, never guess. Absent for create is fine (no due date is a valid task). */
  needsClarification?: string;
}

const TASKS_WEBSITE_NAV_RE = /\b(?:open|go to|navigate to|visit)\s+(?:tasks\.google\.com|google\s+tasks)\b/i;

const DAY_WORD_RE = /\b(?:today|tomorrow|next\s+\w+|on\s+\w+|due\s+\w+|by\s+\w+|sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i;

const LIST_TASKLISTS_RE = /\b(?:list|show)\s+(?:my\s+)?task\s*lists\b|\bwhat\s+task\s*lists\b/i;
const LIST_TASKS_TODAY_RE =
  /\b(?:what\s+tasks?\s+do\s+i\s+have|what\s+do\s+i\s+need\s+to\s+do|what\s+do\s+i\s+have\s+to\s+do)\b.{0,25}\b(today|tomorrow)\b/i;
const LIST_TASKS_RE = /\b(?:list|show)\s+(?:my\s+)?tasks\b/i;
const SEARCH_TASK_RE = /\bfind\s+(?:my\s+|the\s+)?(.+?)\s+task\b|\bfind\s+task\s+(.+)$/i;
const CREATE_REMIND_RE = /\bremind me to\b\s+(.+)$/i;
const CREATE_ADD_RE = /\badd\s+(?:a\s+)?(?:task|reminder)\s+(?:to|that)\s+(.+)$/i;
// \btasks?\b (not just \btask\b) — caught live: "Mark JARVIS Tasks
// Integration Test complete" fell through to the generic browser path
// entirely, because the task's own title contains "Tasks" (plural) and the
// singular-only requirement never matched anywhere in the phrase. Same root
// cause as Checkpoint 18's CANCEL_VERB_RE bug ("Cancel my JARVIS Calendar
// Integration Test" had no matching generic noun) — a real test's own name
// tripped a noun-word-boundary requirement, found via live testing.
const UPDATE_VERB_RE = /\b(?:change|move|reschedule)\b.{0,50}\btasks?\b/i;
const COMPLETE_VERB_RE = /\bmark\b.{0,40}\btasks?\b.{0,20}\b(?:complete|done)\b|\bmark\b.{0,40}\bas\s+(?:complete|done)\b.{0,20}\btasks?\b|\b(?:complete|finish)\b.{0,30}\btasks?\b/i;
const DELETE_VERB_RE = /\b(?:delete|remove)\b.{0,40}\btasks?\b/i;

/** Strips verb/filler/date words out of a target-reference phrase, mirroring calendar/intent.ts's stripSearchNoise — same reason: a plain-terms search must not include words that will never appear in a real task's title. */
function stripTaskNoise(text: string): string {
  return text
    .replace(/\b(?:mark|complete|finish|delete|remove|change|move|reschedule)\b/gi, '')
    .replace(/\b(?:my|the|a|an|as|to)\b/gi, '')
    .replace(/\btasks?\b|\breminders?\b/gi, '')
    .replace(/\bdone\b/gi, '')
    .replace(DAY_WORD_RE, '')
    .replace(/[.,!?]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Extracts a title from a "remind me to X <day-phrase>" / "add a task to X <day-phrase>" match, stopping before the day-phrase. */
function titleAndDue(rest: string): { title: string; due?: string; needsClarification?: string } {
  const dayMatch = DAY_WORD_RE.exec(rest);
  const title = (dayMatch ? rest.slice(0, dayMatch.index) : rest).replace(/[.,!?]+$/g, '').trim();
  const capitalized = title ? title.charAt(0).toUpperCase() + title.slice(1) : 'Task';
  const day = resolveDayPhrase(rest);
  return { title: capitalized, due: day ? taskDueIso(day.daysFromNow) : undefined };
}

export function detectTasksIntent(task: string): TasksIntent | null {
  const t = task.trim();
  const timezone = DEFAULT_TIMEZONE;
  if (TASKS_WEBSITE_NAV_RE.test(t)) return null;
  if (GMAIL_EMAIL_VERB_RE.test(t)) return null;

  if (LIST_TASKLISTS_RE.test(t)) {
    return { operation: 'list_lists', raw: t, timezone };
  }

  const remindMatch = CREATE_REMIND_RE.exec(t);
  if (remindMatch) {
    const { title, due } = titleAndDue(remindMatch[1]);
    return { operation: 'propose_create', raw: t, timezone, title, due };
  }
  const addMatch = CREATE_ADD_RE.exec(t);
  if (addMatch) {
    const { title, due } = titleAndDue(addMatch[1]);
    return { operation: 'propose_create', raw: t, timezone, title, due };
  }

  if (COMPLETE_VERB_RE.test(t)) {
    return { operation: 'propose_complete', raw: t, timezone, searchQuery: stripTaskNoise(t) };
  }

  if (DELETE_VERB_RE.test(t)) {
    return { operation: 'propose_delete', raw: t, timezone, searchQuery: stripTaskNoise(t) };
  }

  if (UPDATE_VERB_RE.test(t)) {
    const toMatch = /\bto\s+(.+)$/i.exec(t);
    const day = toMatch ? resolveDayPhrase(toMatch[1]) : resolveDayPhrase(t);
    const searchQuery = stripTaskNoise(toMatch ? t.slice(0, toMatch.index) : t);
    return {
      operation: 'propose_update',
      raw: t,
      timezone,
      searchQuery,
      due: day ? taskDueIso(day.daysFromNow) : undefined,
      needsClarification: !day ? 'Could not resolve the new due date for this update (e.g. "to Friday").' : undefined,
    };
  }

  const searchMatch = SEARCH_TASK_RE.exec(t);
  if (searchMatch) {
    const q = (searchMatch[1] ?? searchMatch[2] ?? '').trim();
    if (q) return { operation: 'search', raw: t, timezone, searchQuery: q };
  }

  if (LIST_TASKS_TODAY_RE.test(t)) {
    const day = resolveDayPhrase(t) ?? { daysFromNow: 0, label: 'today' };
    return { operation: 'list', raw: t, timezone, dueDay: taskDueIso(day.daysFromNow) };
  }

  if (LIST_TASKS_RE.test(t)) {
    return { operation: 'list', raw: t, timezone };
  }

  return null;
}

/** Unambiguous, action-specific confirmation phrases — recognized regardless of pending state. Deliberately OVERLAPS Calendar's own vocabulary ("create it"/"update it"/"delete it") by the spec's own examples (§9) — task-manager.ts resolves the overlap via pending-store state, never by guessing. "mark it complete"/"complete it" has no Calendar equivalent, so it never actually needs the tiebreak in practice. */
export function unambiguousTasksPhraseType(text: string): TasksPendingActionType | null {
  const t = text.trim().toLowerCase();
  if (/^(create it|add it|save it|yes,?\s*create it)\.?!?$/.test(t)) return 'tasks_create';
  if (/^(update it|change it|yes,?\s*update it)\.?!?$/.test(t)) return 'tasks_update';
  if (/^(mark it complete|complete it|mark it done|finish it|yes,?\s*mark it complete)\.?!?$/.test(t)) return 'tasks_complete';
  if (/^(delete it|remove it|yes,?\s*delete it)\.?!?$/.test(t)) return 'tasks_delete';
  return null;
}

/** Ambiguous bare confirmations — only ever consulted by task-manager.ts when exactly one relevant pending store is active. */
export function isAmbiguousTasksConfirmPhrase(text: string): boolean {
  const t = text.trim().toLowerCase();
  return /^(confirm(ed)?|go ahead|yes)\.?!?$/.test(t);
}

/** Explicit rejection — mirrors calendar/intent.ts's isCalendarRejectPhrase. */
export function isTasksRejectPhrase(text: string): boolean {
  const t = text.trim().toLowerCase();
  return /^(no|don'?t (?:do (?:that|it)|create it|update it|complete it|delete it)|never mind|abort|stop)\.?!?$/.test(t);
}
