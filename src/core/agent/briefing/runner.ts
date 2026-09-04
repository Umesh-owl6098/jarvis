/**
 * Checkpoint 27 — builds and renders the daily briefing. Read-only,
 * end-to-end: every capability call below is a LIST/GET, never a
 * create/update/delete/send. No PendingAction store is ever imported or
 * touched here — that's what makes "a briefing request creates zero
 * authorization state" true by construction, not by a runtime check.
 *
 * Flow: fetch Calendar/Tasks/Gmail (each independently, degrading
 * gracefully on its own failure) -> build a small, deterministic,
 * explainable attention ranking from the structured results -> render one
 * coherent response -> store a BOUNDED list of safe item references for
 * the one supported follow-up ("Tell me more about the second item.").
 */

import { nanoid } from 'nanoid';
import type { ExecutionResult } from '../executor';
import type { EventListener } from '../events';
import type {
  DailyBriefing,
  BriefingScope,
  BriefingCalendarData,
  BriefingCalendarEventView,
  BriefingTasksData,
  BriefingTaskView,
  BriefingGmailData,
  AttentionItem,
  BriefingItemRef,
} from './types';
import type { ParsedBriefingIntent } from './intent';
import { detectBriefingFollowUp } from './intent';

import { getCalendarClient, calendarAvailability } from '@/core/capabilities/calendar/resolve';
import { formatLocal } from '@/core/capabilities/calendar/datetime';
import type { CalendarEvent } from '@/core/capabilities/calendar/types';

import { getTasksClient, tasksAvailability } from '@/core/capabilities/tasks/resolve';
import { taskDueIso, formatDueDate } from '@/core/capabilities/tasks/datetime';
import type { TaskItem } from '@/core/capabilities/tasks/types';

import { getGmailClient, gmailAvailability } from '@/core/capabilities/gmail/resolve';

import { rankAttentionSignals, MEETING_SOON_MINUTES } from '../attention/engine';
import type { AttentionSignal } from '../attention/types';

function isAbortError(e: any): boolean {
  return e?.name === 'AbortError' || e?.code === 'ABORTED' || /aborted|cancelled/i.test(e?.message ?? '');
}

// Checkpoint 28 — the "starting soon"/60-minute window is now owned by
// attention/engine.ts (MEETING_SOON_MINUTES, imported above) so Checkpoint
// 27 and 28 share the exact same threshold rather than risking two
// independently-tuned copies drifting apart. Re-exported here so any
// existing importer of this module keeps working unchanged.
export { MEETING_SOON_MINUTES };
// Detailed attention list cap — ONE concise default (no separate voice-mode
// flag: the execution architecture has no signal to distinguish voice from
// typed input, so rather than invent a fake flag, one bounded default is
// used for both, with full counts always stated separately so nothing is
// silently omitted).
export const MAX_ATTENTION_ITEMS = 5;
// How many recent Gmail messages to inspect for unread signals. Gmail has
// no date-range list endpoint (see gmail/types.ts's GmailClient) so this is
// "most recent N overall," not scoped to the requested day — an honest,
// documented limitation rather than an invented filter.
const GMAIL_SCAN_COUNT = 10;

// ============================================================
// Calendar
// ============================================================

function toCalendarView(e: CalendarEvent): BriefingCalendarEventView {
  // Deliberately omits .description — untrusted data, never needed for a
  // briefing line. Mirrors calendar/runner.ts's own formatEventLine().
  return { id: e.id, title: e.title, start: e.start, end: e.end, timezone: e.timezone, location: e.location, attendees: e.attendees };
}

export async function fetchCalendarData(scope: BriefingScope, now: Date, signal?: AbortSignal): Promise<BriefingCalendarData> {
  const avail = calendarAvailability();
  if (!avail.available) {
    return { status: 'unavailable', reason: avail.reason, remainingCount: 0, events: [] };
  }
  try {
    const client = getCalendarClient();
    const raw = await client.listEvents(scope.rangeStart, scope.rangeEnd, 'UTC', 50, signal);
    // "Remaining" = hasn't ended yet relative to NOW — for a future scope
    // (e.g. "tomorrow") every event trivially qualifies; for "today" this
    // correctly excludes meetings that already finished.
    const remaining = raw.filter((e) => new Date(e.end).getTime() >= now.getTime()).sort((a, b) => (a.start < b.start ? -1 : 1));
    const views = remaining.map(toCalendarView);
    return { status: 'ok', remainingCount: views.length, nextEvent: views[0], events: views };
  } catch (e: any) {
    if (isAbortError(e) || signal?.aborted) throw e;
    return { status: 'failed', reason: e?.message ?? 'Calendar read failed.', remainingCount: 0, events: [] };
  }
}

// ============================================================
// Tasks
// ============================================================

function toTaskView(t: TaskItem): BriefingTaskView {
  // Deliberately omits .notes — untrusted data, never needed for a
  // briefing line. Mirrors tasks/runner.ts's own formatTaskLine().
  return { id: t.id, taskListId: t.taskListId, title: t.title, due: t.due };
}

export async function fetchTasksData(scope: BriefingScope, now: Date, signal?: AbortSignal): Promise<BriefingTasksData> {
  const avail = tasksAvailability();
  if (!avail.available) {
    return { status: 'unavailable', reason: avail.reason, overdueCount: 0, dueTodayCount: 0, incompleteCount: 0, overdue: [], dueToday: [] };
  }
  try {
    const client = getTasksClient();
    const all = await client.listTasks(client.defaultListId, 50, signal);
    const incomplete = all.filter((t) => t.status !== 'completed');

    // "Overdue" is always relative to the REAL current date, regardless of
    // which day's briefing was requested — a task doesn't stop being
    // overdue because you asked about tomorrow. Google Tasks' `due` is
    // date-only (see tasks/types.ts) — compared as plain Y-M-D strings,
    // never as a time-of-day.
    const todayYmd = taskDueIso(0).slice(0, 10);
    const scopeYmd = taskDueIso(scope.daysFromNow).slice(0, 10);

    const overdue = incomplete.filter((t) => t.due && t.due.slice(0, 10) < todayYmd);
    // "Due today" generalizes to "due on the requested scope day" — for a
    // "tomorrow" briefing this becomes tasks due tomorrow, per the
    // checkpoint's own instruction.
    const dueOnScopeDay = incomplete.filter((t) => t.due && t.due.slice(0, 10) === scopeYmd);

    return {
      status: 'ok',
      overdueCount: overdue.length,
      dueTodayCount: dueOnScopeDay.length,
      incompleteCount: incomplete.length,
      overdue: overdue.map(toTaskView),
      dueToday: dueOnScopeDay.map(toTaskView),
    };
  } catch (e: any) {
    if (isAbortError(e) || signal?.aborted) throw e;
    return { status: 'failed', reason: e?.message ?? 'Tasks read failed.', overdueCount: 0, dueTodayCount: 0, incompleteCount: 0, overdue: [], dueToday: [] };
  }
}

// ============================================================
// Gmail
// ============================================================

export async function fetchGmailData(signal?: AbortSignal): Promise<BriefingGmailData> {
  const avail = gmailAvailability();
  if (!avail.available) {
    return { status: 'unavailable', reason: avail.reason, recentCount: 0, unreadCount: 0, unread: [] };
  }
  try {
    const client = getGmailClient();
    // listRecent() already fetches Gmail's 'metadata' format only (see
    // gmail/client.ts) — the full body is never pulled over the wire here,
    // .text falls back to Gmail's own short snippet. This briefing NEVER
    // calls getMessage()/getThread() (the only full-body methods), so
    // there is nothing to additionally redact — it was never fetched.
    const recent = await client.listRecent(GMAIL_SCAN_COUNT, signal);
    const unread = recent.filter((m) => m.labels.includes('UNREAD'));
    const unreadViews = unread.map((m) => ({ id: m.id, from: m.from, subject: m.subject, date: m.date, unread: true }));
    return { status: 'ok', recentCount: recent.length, unreadCount: unread.length, unread: unreadViews };
  } catch (e: any) {
    if (isAbortError(e) || signal?.aborted) throw e;
    return { status: 'failed', reason: e?.message ?? 'Gmail read failed.', recentCount: 0, unreadCount: 0, unread: [] };
  }
}

// ============================================================
// Attention ranking — deterministic, structured-metadata only. No
// sentiment analysis, no embeddings, no LLM importance scoring, no
// reading email bodies, no guessed relationships.
// ============================================================

/**
 * Checkpoint 28 — thin adapter over the SHARED classifier
 * (attention/engine.ts's rankAttentionSignals). All tiering, ordering, and
 * tie-breaking now lives in exactly one place; this function's only job is
 * translating the engine's normalized AttentionSignal[] into this
 * checkpoint's own AttentionItem/BriefingItemRef shapes and its own
 * (Checkpoint-27-specific) sentence wording — the render text intentionally
 * differs from Checkpoint 28's own wording, only the classification is
 * shared. Produces byte-identical output to the pre-extraction
 * implementation (see the CP28 regression suite).
 */
function buildAttention(calendar: BriefingCalendarData, tasks: BriefingTasksData, gmail: BriefingGmailData, now: Date, dayLabel: string): AttentionItem[] {
  const signals = rankAttentionSignals(
    { calendarEvents: calendar.events, tasksOverdue: tasks.overdue, tasksDueInScope: tasks.dueToday, gmailUnread: gmail.unread },
    now,
    MEETING_SOON_MINUTES
  );
  const eventById = new Map(calendar.events.map((e) => [e.id, e]));
  const mailById = new Map(gmail.unread.map((m) => [m.id, m]));

  // Builds the key set conditionally (never an explicit `taskListId:
  // undefined` property) — a plain object literal with `taskListId:
  // s.taskListId` would still create the KEY even when the value is
  // undefined, which is a real, different shape from the original
  // per-branch literals that omitted the key entirely for calendar/gmail.
  const toRef = (s: AttentionSignal): BriefingItemRef =>
    s.taskListId !== undefined
      ? { capability: s.source, id: s.id, taskListId: s.taskListId, label: s.label }
      : { capability: s.source, id: s.id, label: s.label };

  return signals.map((s): AttentionItem => {
    const ref = toRef(s);
    switch (s.reason) {
      case 'task_overdue':
        return { tier: s.tier, ref, label: `Overdue task: ${s.label}` };
      case 'task_due':
        return { tier: s.tier, ref, label: `Due ${dayLabel}: ${s.label} (${s.timestamp ? formatDueDate(s.timestamp) : 'no date'})` };
      case 'meeting_soon': {
        const e = eventById.get(s.id)!;
        return { tier: s.tier, ref, label: `Meeting at ${formatLocal(e.start, e.timezone)} with ${e.title}` };
      }
      case 'meeting_upcoming': {
        const e = eventById.get(s.id)!;
        return { tier: s.tier, ref, label: `Meeting at ${formatLocal(e.start, e.timezone)}: ${e.title}` };
      }
      case 'unread_mail': {
        const m = mailById.get(s.id)!;
        return { tier: s.tier, ref, label: `Recent email from ${m.from}: ${m.subject}` };
      }
    }
  });
}

// ============================================================
// Rendering
// ============================================================

function greeting(now: Date): string {
  // A full 24h partition for a natural greeting — intentionally distinct
  // from calendar/datetime.ts's DAY_PART_RANGES, which only covers 9–20
  // and exists for a different purpose (filtering events within a NAMED
  // "morning/afternoon/evening" phrase, not greeting the user at any hour).
  const hour = now.getHours();
  if (hour < 12) return 'GOOD MORNING.';
  if (hour < 17) return 'GOOD AFTERNOON.';
  return 'GOOD EVENING.';
}

function renderCalendarLines(c: BriefingCalendarData, scope: BriefingScope): string[] {
  if (c.status !== 'ok') return [];
  const lines: string[] = [];
  if (c.remainingCount === 0) {
    lines.push(`You have no meetings ${scope.dayLabel}.`);
  } else {
    lines.push(`You have ${c.remainingCount} meeting${c.remainingCount === 1 ? '' : 's'} ${scope.dayLabel}.`);
    if (c.nextEvent) lines.push(`Your next meeting is at ${formatLocal(c.nextEvent.start, c.nextEvent.timezone)}.`);
  }
  return lines;
}

function renderTasksLines(t: BriefingTasksData, dayLabel: string): string[] {
  if (t.status !== 'ok') return [];
  const lines: string[] = [];
  if (t.dueTodayCount > 0) lines.push(`${t.dueTodayCount} task${t.dueTodayCount === 1 ? ' is' : 's are'} due ${dayLabel}.`);
  if (t.overdueCount > 0) lines.push(`${t.overdueCount} task${t.overdueCount === 1 ? ' is' : 's are'} overdue.`);
  if (t.dueTodayCount === 0 && t.overdueCount === 0) lines.push(`No tasks are due ${dayLabel} or overdue.`);
  return lines;
}

function renderGmailLines(g: BriefingGmailData): string[] {
  if (g.status !== 'ok') return [];
  if (g.unreadCount === 0) return ['No recent mail needs attention.'];
  return [`You have ${g.unreadCount} recent email${g.unreadCount === 1 ? '' : 's'} that may need attention.`];
}

function unavailableNote(name: string, data: { status: string; reason?: string }): string | null {
  if (data.status === 'ok') return null;
  return `${name} wasn't available${data.reason ? ` (${data.reason})` : ''}.`;
}

function renderBriefing(b: DailyBriefing, now: Date): string {
  const unavailableParts = [
    unavailableNote('Calendar', b.calendar),
    unavailableNote('Tasks', b.tasks),
    unavailableNote('Gmail', b.gmail),
  ].filter((x): x is string => !!x);

  const isCompletelyClear =
    b.calendar.status === 'ok' &&
    b.tasks.status === 'ok' &&
    b.calendar.remainingCount === 0 &&
    b.tasks.overdueCount === 0 &&
    b.tasks.dueTodayCount === 0 &&
    (b.gmail.status !== 'ok' || b.gmail.unreadCount === 0) &&
    b.attention.length === 0;

  const lines: string[] = [greeting(now), ''];

  if (unavailableParts.length > 0) {
    const ok = [
      b.calendar.status === 'ok' ? 'calendar' : null,
      b.tasks.status === 'ok' ? 'tasks' : null,
      b.gmail.status === 'ok' ? 'Gmail' : null,
    ].filter(Boolean);
    if (ok.length > 0) {
      lines.push(`I could read your ${ok.join(' and ')}, but ${unavailableParts.join(' ')}`);
    } else {
      lines.push(`I couldn't read any of your sources: ${unavailableParts.join(' ')}`);
    }
    lines.push('');
  }

  if (isCompletelyClear) {
    // Never claims "no recent mail requiring attention" when Gmail
    // actually couldn't be read at all — that would assert something never
    // verified. The mail clause is only ever stated when Gmail genuinely
    // returned zero unread messages.
    const mailClause = b.gmail.status === 'ok' ? ' and no recent mail requiring attention' : '';
    lines.push(`Your schedule is clear ${b.scope.dayLabel}. You have no due tasks${mailClause}.`);
    return lines.join('\n').trim();
  }

  lines.push(...renderCalendarLines(b.calendar, b.scope));
  lines.push('');
  lines.push(...renderTasksLines(b.tasks, b.scope.dayLabel));
  lines.push('');
  lines.push(...renderGmailLines(b.gmail));

  if (b.attention.length > 0) {
    lines.push('');
    lines.push('PRIORITY');
    if (b.attentionTotalCount > b.attention.length) {
      lines.push(`(Showing the top ${b.attention.length} of ${b.attentionTotalCount} items needing attention.)`);
    }
    b.attention.forEach((item, i) => lines.push(`${i + 1}. ${item.label}`));
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ============================================================
// Bounded, session-keyed, TTL-bounded briefing-item-reference store —
// architecturally a sibling of pending-slot.ts (same Map<sessionId,T>/TTL/
// clear discipline), NOT an extension of CP22's conversation-context.ts:
// that store holds one SINGLE target reference per turn; this checkpoint
// needs a bounded LIST (up to MAX_ATTENTION_ITEMS), which would have meant
// widening conversation-context.ts's own shape for every other capability
// that reads it. A small dedicated sibling store avoids that entirely.
// ============================================================

interface BriefingReferenceState {
  items: BriefingItemRef[];
  createdAt: number;
}

const BRIEFING_REF_TTL_MS = 10 * 60 * 1000; // matches conversation-context.ts's CONTEXT_TTL_MS / pending-slot.ts's PENDING_SLOT_TTL_MS

class BriefingReferenceStore {
  private sessions = new Map<string, BriefingReferenceState>();

  set(sessionId: string, items: BriefingItemRef[]): void {
    this.sessions.set(sessionId, { items, createdAt: Date.now() });
  }

  active(sessionId: string): BriefingItemRef[] | null {
    const state = this.sessions.get(sessionId);
    if (!state) return null;
    if (Date.now() - state.createdAt > BRIEFING_REF_TTL_MS) {
      this.sessions.delete(sessionId);
      return null;
    }
    return state.items;
  }

  /** Cleared on "Start over." — same reasoning as pending-slot.ts's own clear(). */
  clear(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  pruneAllExpired(): void {
    const cutoff = Date.now() - BRIEFING_REF_TTL_MS;
    for (const [sessionId, state] of this.sessions) {
      if (state.createdAt < cutoff) this.sessions.delete(sessionId);
    }
  }

  /** Number of sessions currently holding a reference list — test/debug only, mirrors pending-slot.ts's own sessionCount. */
  get sessionCount(): number {
    return this.sessions.size;
  }

  /** TEST-ONLY — mirrors pending-slot.ts's __setForTesting. */
  __setForTesting(sessionId: string, items: BriefingItemRef[], createdAt: number): void {
    this.sessions.set(sessionId, { items, createdAt });
  }
}

export const briefingReferenceStore = new BriefingReferenceStore();

async function fetchAndRank(scope: BriefingScope, now: Date, signal: AbortSignal | undefined) {
  const [calendar, tasks, gmail] = await Promise.all([
    fetchCalendarData(scope, now, signal),
    fetchTasksData(scope, now, signal),
    fetchGmailData(signal),
  ]);
  const allAttention = buildAttention(calendar, tasks, gmail, now, scope.dayLabel);
  return { calendar, tasks, gmail, allAttention };
}

/**
 * TEST-ONLY — the FULL, UNBOUNDED attention ranking (before the
 * MAX_ATTENTION_ITEMS cap the real rendered response applies), so ordering
 * can be verified deterministically without depending on how much other
 * shared mock-fixture noise happens to already occupy the top of the
 * bounded, user-facing list. Mirrors this codebase's established
 * __setForTesting/__pushForTesting convention. Not reachable from any
 * user-facing text/command.
 */
export async function __rankAttentionForTesting(scope: BriefingScope, now: Date = new Date(), signal?: AbortSignal): Promise<AttentionItem[]> {
  const { allAttention } = await fetchAndRank(scope, now, signal);
  return allAttention;
}

// ============================================================
// Entry points
// ============================================================

export async function runBriefing(
  parsed: ParsedBriefingIntent,
  onEvent: EventListener,
  signal: AbortSignal | undefined,
  sessionId: string,
  taskId: string,
  now: Date = new Date()
): Promise<ExecutionResult> {
  onEvent({ type: 'task.started', timestamp: Date.now(), taskId, data: { task: 'briefing', capability: 'briefing' as any } });

  if (parsed.kind === 'unsupported_compound') {
    const resultText =
      `I can give you a briefing, or handle "${parsed.tailText}" as a separate request, ` +
      `but I don't have a supported way to do both from one command yet. ` +
      `Try asking for the briefing first, then the other request separately.`;
    onEvent({ type: 'agent.completed', timestamp: Date.now(), taskId, data: { result: resultText, capability: 'briefing' as any } });
    return {
      taskId, goal: 'briefing', status: 'success', outcome: 'blocked', result: resultText,
      steps: 0, tokensUsed: 0, actions: [], events: [],
      capability: { selected: 'briefing', reason: 'Briefing request combined with an unsupported compound action.', readAttempted: false, browserFallbackUsed: false },
    };
  }

  const { scope } = parsed;
  const { calendar, tasks, gmail, allAttention } = await fetchAndRank(scope, now, signal);
  const bounded = allAttention.slice(0, MAX_ATTENTION_ITEMS);

  const briefing: DailyBriefing = { scope, calendar, tasks, gmail, attention: bounded, attentionTotalCount: allAttention.length };
  const resultText = renderBriefing(briefing, now);

  // Bounded, safe references only — never Gmail bodies/Calendar
  // descriptions/Task notes/OAuth payloads (see BriefingItemRef's own doc).
  briefingReferenceStore.set(sessionId, bounded.map((a) => a.ref));

  onEvent({ type: 'agent.completed', timestamp: Date.now(), taskId, data: { result: resultText, capability: 'briefing' as any } });

  return {
    taskId, goal: 'briefing', status: 'success', outcome: 'completed', result: resultText,
    steps: 0, tokensUsed: 0, actions: [], events: [],
    capability: { selected: 'briefing', reason: 'Recognized as a daily-briefing request.', readAttempted: false, browserFallbackUsed: false },
    briefing: {
      scope,
      calendarStatus: calendar.status,
      tasksStatus: tasks.status,
      gmailStatus: gmail.status,
      attentionCount: bounded.length,
      attentionTotalCount: allAttention.length,
    },
  };
}

// ============================================================
// Bounded follow-up: "Tell me more about the second item."
// ============================================================

async function renderItemDetail(ref: BriefingItemRef, signal?: AbortSignal): Promise<string> {
  if (ref.capability === 'calendar') {
    const avail = calendarAvailability();
    if (!avail.available) return `Calendar isn't available right now (${avail.reason}).`;
    const event = await getCalendarClient().getEvent(ref.id, signal);
    if (!event) return `I couldn't find that event anymore — it may have changed since your briefing.`;
    const lines = [`Title: ${event.title}`, `When: ${formatLocal(event.start, event.timezone)} to ${formatLocal(event.end, event.timezone)}`];
    if (event.location) lines.push(`Location: ${event.location}`);
    if (event.attendees.length) lines.push(`Attendees: ${event.attendees.join(', ')}`);
    return lines.join('\n');
  }
  if (ref.capability === 'tasks') {
    const avail = tasksAvailability();
    if (!avail.available) return `Tasks isn't available right now (${avail.reason}).`;
    const task = await getTasksClient().getTask(ref.taskListId!, ref.id, signal);
    if (!task) return `I couldn't find that task anymore — it may have changed since your briefing.`;
    const lines = [`Title: ${task.title}`];
    if (task.due) lines.push(`Due: ${formatDueDate(task.due)}`);
    lines.push(`Status: ${task.status === 'completed' ? 'Completed' : 'Needs action'}`);
    return lines.join('\n');
  }
  // Gmail — re-presents the SAME safe metadata already shown in the
  // briefing; a daily briefing is never blanket authorization to read a
  // full message body, so this NEVER calls getMessage()/getThread(). If
  // the user wants the actual content, they can explicitly ask to read it
  // — that goes through Gmail's own existing, unrelated read path.
  return `${ref.label}\n\n(This is the same summary shown in your briefing. Say "read that email" if you'd like me to open the full message.)`;
}

export async function attemptBriefingFollowUp(
  goal: string,
  providedTaskId: string | undefined,
  onEvent: EventListener,
  signal: AbortSignal | undefined,
  sessionId: string
): Promise<ExecutionResult | null> {
  const idx = detectBriefingFollowUp(goal);
  if (idx === null) return null;

  const taskId = providedTaskId || nanoid();
  const items = briefingReferenceStore.active(sessionId);

  let resultText: string;
  if (!items || items.length === 0) {
    resultText = "I don't have a recent briefing to reference — ask for your briefing first.";
  } else if (idx >= items.length) {
    resultText = `Your last briefing only had ${items.length} item${items.length === 1 ? '' : 's'} — there's no item #${idx + 1}.`;
  } else {
    resultText = await renderItemDetail(items[idx], signal);
  }

  onEvent({ type: 'agent.completed', timestamp: Date.now(), taskId, data: { result: resultText, capability: 'briefing' as any } });
  return {
    taskId, goal, status: 'success', outcome: 'completed', result: resultText,
    steps: 0, tokensUsed: 0, actions: [], events: [],
    capability: { selected: 'briefing', reason: 'Bounded follow-up on the last briefing\'s attention list.', readAttempted: false, browserFallbackUsed: false },
  };
}
