/**
 * Checkpoint 28 — builds and renders the personal-attention check.
 * Read-only, end-to-end: reuses Checkpoint 27's own fetch functions
 * (fetchCalendarData/fetchTasksData/fetchGmailData — no second copy of
 * the Calendar/Tasks/Gmail read logic) and the SHARED classifier
 * (attention/engine.ts's rankAttentionSignals — no second, competing
 * ranking implementation). No PendingAction store is ever imported or
 * touched here.
 *
 * Reuses CP27's own bounded, session-keyed, TTL-bounded
 * briefingReferenceStore for "Tell me more about the Nth item" rather
 * than introducing a second parallel reference store — see the CP28
 * report for why this is a safe, coherent reuse (same shape, same
 * session/TTL/Start-over discipline, same reference-is-not-authorization
 * guarantee already fully tested in CP27).
 */

import type { ExecutionResult } from '../executor';
import type { EventListener } from '../events';
import { fetchCalendarData, fetchTasksData, fetchGmailData, briefingReferenceStore, MAX_ATTENTION_ITEMS } from '../briefing/runner';
import type { BriefingScope, BriefingItemRef, BriefingCalendarData, BriefingTasksData, BriefingGmailData } from '../briefing/types';
import { rankAttentionSignals, MEETING_SOON_MINUTES } from './engine';
import type { AttentionSignal, AttentionScope } from './types';
import type { ParsedAttentionIntent } from './intent';

// Both the real Google Calendar API (`timeMax`) and MockCalendarClient's own
// filter treat the fetch range's upper bound as EXCLUSIVE — a meeting
// starting at exactly that instant is silently never returned at all. CP28's
// own window semantics ("current time through +60/+240 minutes") are
// inclusive of that exact instant, and the shared engine's own tier
// comparison already encodes that (`start <= soonCutoff`). Without this pad,
// a meeting landing exactly on the +60m/+240m boundary would never reach the
// engine to be classified — pad ONLY the Calendar FETCH's upper bound for
// 'right_now'/'soon' scopes so it is retrieved, then let the engine's own
// already-inclusive comparison decide its tier. 'day' scopes reuse CP27's
// own day/daypart boundaries unchanged (exclusive-at-midnight is correct
// there) and are deliberately never padded.
const CALENDAR_FETCH_END_PAD_MS = 1000;

function toBriefingScope(scope: AttentionScope): BriefingScope {
  const rangeEnd =
    scope.kind === 'right_now' || scope.kind === 'soon'
      ? new Date(new Date(scope.rangeEnd).getTime() + CALENDAR_FETCH_END_PAD_MS).toISOString()
      : scope.rangeEnd;
  return { daysFromNow: scope.tasksDayOffset, dayLabel: scope.label, dayPart: null, rangeStart: scope.rangeStart, rangeEnd };
}

function joinNatural(parts: string[]): string {
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`;
}

function renderSignalSentence(s: AttentionSignal, now: Date): string {
  if (s.reason === 'task_overdue') return `"${s.label}" is overdue.`;
  if (s.reason === 'meeting_soon') {
    const minutes = Math.max(0, Math.round((new Date(s.timestamp!).getTime() - now.getTime()) / 60000));
    return minutes <= 0 ? `"${s.label}" starts now.` : `"${s.label}" starts in ${minutes} minute${minutes === 1 ? '' : 's'}.`;
  }
  // Not reachable for a Tier-1 signal today (only task_overdue/meeting_soon
  // are ever Tier 1) — kept as an honest fallback, never silently blank.
  return `"${s.label}".`;
}

interface SourceStatus {
  name: string;
  status: 'ok' | 'unavailable' | 'failed';
  reason?: string;
}

function renderAttentionCheck(signals: AttentionSignal[], sources: SourceStatus[], scope: AttentionScope, now: Date): string {
  const tier1 = signals.filter((s) => s.tier === 1);
  const tier2 = signals.filter((s) => s.tier === 2);
  const tier3 = signals.filter((s) => s.tier === 3);

  const okNames = sources.filter((s) => s.status === 'ok').map((s) => s.name);
  const failedNotes = sources.filter((s) => s.status !== 'ok').map((s) => `${s.name} wasn't available${s.reason ? ` (${s.reason})` : ''}.`);
  const failedNames = sources.filter((s) => s.status !== 'ok').map((s) => s.name);

  if (tier1.length === 0) {
    let head: string;
    if (failedNames.length > 0 && okNames.length > 0) {
      head = `I didn't find anything urgent in ${joinNatural(okNames)}, but ${failedNotes.join(' ')}`;
    } else if (failedNames.length > 0 && okNames.length === 0) {
      head = `I couldn't check any of your sources: ${failedNotes.join(' ')}`;
    } else {
      head = 'Nothing urgent right now.';
    }
    const laterCount = tier2.length + tier3.length;
    if (laterCount > 0) {
      head += ` You do have ${laterCount} thing${laterCount === 1 ? '' : 's'} coming up ${scope.label}.`;
    }
    return head.trim();
  }

  const lines: string[] = [];
  if (failedNotes.length > 0) {
    lines.push(failedNotes.join(' '));
    lines.push('');
  }

  const bounded = tier1.slice(0, MAX_ATTENTION_ITEMS);
  lines.push(`${bounded.length} thing${bounded.length === 1 ? '' : 's'} need${bounded.length === 1 ? 's' : ''} your attention:`);
  lines.push('');
  if (tier1.length > bounded.length) lines.push(`(Showing the top ${bounded.length} of ${tier1.length} urgent items.)`);
  bounded.forEach((s, i) => lines.push(`${i + 1}. ${renderSignalSentence(s, now)}`));

  const trailing: string[] = [];
  const dueCount = tier2.filter((s) => s.reason === 'task_due').length;
  const unreadCount = tier2.filter((s) => s.reason === 'unread_mail').length;
  const laterCount = tier3.length;
  if (dueCount > 0) trailing.push(`${dueCount} due task${dueCount === 1 ? '' : 's'}`);
  if (unreadCount > 0) trailing.push(`${unreadCount} unread recent email${unreadCount === 1 ? '' : 's'}`);
  if (laterCount > 0) trailing.push(`${laterCount} later meeting${laterCount === 1 ? '' : 's'}`);
  if (trailing.length > 0) {
    lines.push('');
    lines.push(`You also have ${joinNatural(trailing)} ${scope.label}.`);
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

async function fetchAndRank(scope: AttentionScope, now: Date, signal: AbortSignal | undefined) {
  const briefingScope = toBriefingScope(scope);
  const [calendar, tasks, gmail] = await Promise.all([
    fetchCalendarData(briefingScope, now, signal),
    fetchTasksData(briefingScope, now, signal),
    fetchGmailData(signal),
  ]);
  // The per-meeting URGENCY threshold (60 min) is fixed regardless of how
  // far OUT the query's own fetch window looked ("soon" only widens what
  // gets fetched at all; it never stretches what counts as "starting soon").
  const signals = rankAttentionSignals(
    { calendarEvents: calendar.events, tasksOverdue: tasks.overdue, tasksDueInScope: tasks.dueToday, gmailUnread: gmail.unread },
    now,
    MEETING_SOON_MINUTES
  );
  return { calendar, tasks, gmail, signals };
}

/** TEST-ONLY — the full unbounded signal ranking for a given scope, bypassing text-grammar parsing so tests can inject an exact scope + `now`. Mirrors briefing/runner.ts's own __rankAttentionForTesting. */
export async function __rankSignalsForTesting(scope: AttentionScope, now: Date = new Date(), signal?: AbortSignal): Promise<AttentionSignal[]> {
  const { signals } = await fetchAndRank(scope, now, signal);
  return signals;
}

export async function runAttentionCheck(
  parsed: ParsedAttentionIntent,
  onEvent: EventListener,
  signal: AbortSignal | undefined,
  sessionId: string,
  taskId: string,
  now: Date = new Date()
): Promise<ExecutionResult> {
  onEvent({ type: 'task.started', timestamp: Date.now(), taskId, data: { task: 'attention', capability: 'attention' as any } });

  if (parsed.kind === 'unsupported_compound') {
    const resultText =
      `I can check what needs your attention, or handle "${parsed.tailText}" as a separate request, ` +
      `but I don't have a supported way to do both from one command yet. ` +
      `Try asking about your attention items first, then the other request separately.`;
    onEvent({ type: 'agent.completed', timestamp: Date.now(), taskId, data: { result: resultText, capability: 'attention' as any } });
    return {
      taskId, goal: 'attention', status: 'success', outcome: 'blocked', result: resultText,
      steps: 0, tokensUsed: 0, actions: [], events: [],
      capability: { selected: 'attention', reason: 'Attention check combined with an unsupported compound action.', readAttempted: false, browserFallbackUsed: false },
    };
  }

  const { scope } = parsed;
  const { calendar, tasks, gmail, signals } = await fetchAndRank(scope, now, signal);

  const sources: SourceStatus[] = [
    { name: 'Calendar', status: calendar.status, reason: calendar.reason },
    { name: 'Tasks', status: tasks.status, reason: tasks.reason },
    { name: 'Gmail', status: gmail.status, reason: gmail.reason },
  ];

  const resultText = renderAttentionCheck(signals, sources, scope, now);

  // Only the itemized (Tier 1) signals are numbered in the rendered
  // response, so only those are stored as follow-up references — matches
  // what the user actually sees "1."/"2." next to. Reuses CP27's own
  // store/TTL/session/Start-over discipline unchanged.
  const tier1Bounded = signals.filter((s) => s.tier === 1).slice(0, MAX_ATTENTION_ITEMS);
  const refs: BriefingItemRef[] = tier1Bounded.map((s) =>
    s.taskListId !== undefined
      ? { capability: s.source, id: s.id, taskListId: s.taskListId, label: s.label }
      : { capability: s.source, id: s.id, label: s.label }
  );
  briefingReferenceStore.set(sessionId, refs);

  onEvent({ type: 'agent.completed', timestamp: Date.now(), taskId, data: { result: resultText, capability: 'attention' as any } });

  return {
    taskId, goal: 'attention', status: 'success', outcome: 'completed', result: resultText,
    steps: 0, tokensUsed: 0, actions: [], events: [],
    capability: { selected: 'attention', reason: 'Recognized as a personal-attention check.', readAttempted: false, browserFallbackUsed: false },
    attention: {
      scope: { kind: scope.kind, label: scope.label },
      calendarStatus: calendar.status,
      tasksStatus: tasks.status,
      gmailStatus: gmail.status,
      urgentCount: tier1Bounded.length,
      urgentTotalCount: signals.filter((s) => s.tier === 1).length,
    },
  };
}
