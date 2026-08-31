/**
 * Checkpoint 22 — conversational revision of an EXISTING pending proposal
 * ("Make that 3 PM", "Make it shorter"). This never creates a second,
 * unrelated proposal and never itself confirms/executes anything — it
 * only overwrites the SAME PendingAction slot (calendar/tasks) or, for
 * Gmail, calls the real backend's own update-in-place operation
 * (updateDraft) rather than creating a duplicate draft. The existing
 * confirmation gate ("Create it."/"Send it.") is completely unchanged and
 * still required afterward — revision is a distinct step from
 * authorization, exactly like the original propose-then-confirm flow.
 *
 * Checked EARLY in runTask(), before any existing capability detector —
 * "make that 3pm" doesn't match any of their trigger vocabularies, so
 * this is safe to try first and simply return null when it doesn't apply.
 */

import type { ExecutionResult } from './executor';
import type { EventListener } from './events';
import { nanoid } from 'nanoid';

import { calendarPendingActionStore } from '@/core/capabilities/calendar/pending-action';
import { resolveClockTime, resolveDayPhrase, formatLocal } from '@/core/capabilities/calendar/datetime';
import type { CalendarProposal } from '@/core/capabilities/calendar/types';

import { tasksPendingActionStore } from '@/core/capabilities/tasks/pending-action';
import { taskDueIso, formatDueDate } from '@/core/capabilities/tasks/datetime';
import type { TaskProposal } from '@/core/capabilities/tasks/types';

import { pendingActionStore } from '@/core/capabilities/gmail/pending-action';
import { getGmailClient } from '@/core/capabilities/gmail/resolve';

const MAKE_THAT_RE = /^(?:actually,?\s*)?make (?:that|it)\s+(.+?)\.?$/i;
const SHORTER_RE = /^(?:a bit |a little )?shorter$/i;

function baseResult(taskId: string, rawGoal: string, resultText: string, extra: Partial<ExecutionResult> = {}): ExecutionResult {
  return {
    taskId, goal: rawGoal, status: 'success', outcome: 'completed', result: resultText,
    steps: 0, tokensUsed: 0, actions: ['revision:proposal'], events: [],
    capability: { selected: 'orchestration', reason: 'Revised a pending proposal conversationally.', readAttempted: false, browserFallbackUsed: false },
    ...extra,
  };
}

function clarifyResult(taskId: string, rawGoal: string, resultText: string): ExecutionResult {
  return {
    taskId, goal: rawGoal, status: 'success', outcome: 'blocked', result: resultText,
    steps: 0, tokensUsed: 0, actions: [], events: [],
    capability: { selected: 'orchestration', reason: 'Ambiguous which pending action to revise.', readAttempted: false, browserFallbackUsed: false },
  };
}

function reviseCalendar(rawGoal: string, taskId: string, onEvent: EventListener, clock: { hour: number; minute: number } | null, day: { daysFromNow: number; label: string } | null, sessionId: string): ExecutionResult {
  const action = calendarPendingActionStore.active(sessionId)!;
  const proposal = action.proposal;
  if (proposal.kind === 'delete') {
    const resultText = "That pending action is a cancellation, not a scheduled time — there's nothing to move.";
    return clarifyResult(taskId, rawGoal, resultText);
  }
  const oldStart = new Date(proposal.start);
  const duration = new Date(proposal.end).getTime() - new Date(proposal.start).getTime();
  let hour = oldStart.getHours();
  let minute = oldStart.getMinutes();
  let base = new Date();
  base = day ? new Date(base.getFullYear(), base.getMonth(), base.getDate() + day.daysFromNow) : oldStart;
  if (clock) { hour = clock.hour; minute = clock.minute; }
  const newStartDate = new Date(base.getFullYear(), base.getMonth(), base.getDate(), hour, minute, 0, 0);
  const newStart = newStartDate.toISOString();
  const newEnd = new Date(newStartDate.getTime() + duration).toISOString();
  const revised: CalendarProposal = { ...proposal, start: newStart, end: newEnd };
  calendarPendingActionStore.set(sessionId, { type: action.type, proposal: revised, createdAt: Date.now() });

  const resultText = `EVENT PROPOSAL UPDATED — still pending confirmation\n\nTITLE: ${revised.title}\nSTART: ${formatLocal(newStart, revised.timezone)}\nEND: ${formatLocal(newEnd, revised.timezone)}\n\nSay "Create it." to confirm, or make another change.`;
  onEvent({ type: 'agent.completed', timestamp: Date.now(), taskId, data: { result: resultText, capability: 'calendar' } });
  return baseResult(taskId, rawGoal, resultText, {
    calendar: { operation: 'propose_create', pendingAction: { type: action.type, title: revised.title, start: newStart, confirmationRequired: true } },
  });
}

function reviseTasks(rawGoal: string, taskId: string, onEvent: EventListener, day: { daysFromNow: number; label: string }, sessionId: string): ExecutionResult {
  const action = tasksPendingActionStore.active(sessionId)!;
  const proposal = action.proposal;
  if (proposal.kind === 'delete' || proposal.kind === 'complete') {
    const resultText = "That pending action isn't a due-date change — there's nothing to move.";
    return clarifyResult(taskId, rawGoal, resultText);
  }
  const newDue = taskDueIso(day.daysFromNow);
  const revised: TaskProposal = { ...proposal, due: newDue };
  tasksPendingActionStore.set(sessionId, { type: action.type, proposal: revised, createdAt: Date.now() });

  const resultText = `TASK PROPOSAL UPDATED — still pending confirmation\n\nTASK: ${revised.title}\nNEW DUE DATE: ${formatDueDate(newDue)}\n\nSay "Create it." to confirm, or make another change.`;
  onEvent({ type: 'agent.completed', timestamp: Date.now(), taskId, data: { result: resultText, capability: 'tasks' } });
  return baseResult(taskId, rawGoal, resultText, {
    tasks: { operation: 'propose_create', pendingAction: { type: action.type, title: revised.title, due: newDue, confirmationRequired: true } },
  });
}

/** A simple, deterministic truncation heuristic — NOT true summarization (no LLM call here, deliberately, to keep this checkpoint bounded). Cuts to the first sentence, or a fixed character budget if there's no clear sentence boundary. */
function shortenText(body: string): string {
  const trimmed = body.trim();
  const firstSentence = /^(.+?[.!?])(\s|$)/.exec(trimmed);
  // Only use the "first sentence" extraction if it's ACTUALLY shorter than
  // the whole thing — caught live: a body that's already just one sentence
  // matches this regex against its ENTIRE length (the only period IS the
  // final one), so naively returning group 1 changed nothing at all. Falls
  // back to a fixed character budget whenever the first-sentence cut
  // wouldn't shorten anything.
  if (firstSentence && firstSentence[1].length >= 10 && firstSentence[1].length < trimmed.length) {
    return firstSentence[1];
  }
  return trimmed.length > 80 ? `${trimmed.slice(0, 80).trim()}…` : trimmed;
}

async function reviseGmailShorter(rawGoal: string, taskId: string, onEvent: EventListener, signal: AbortSignal | undefined, sessionId: string): Promise<ExecutionResult> {
  const action = pendingActionStore.active(sessionId)!;
  const client = getGmailClient();
  const current = client.getDraft(action.draftId);
  if (!current) {
    const resultText = "I couldn't find the pending draft's own content to revise — it may have expired.";
    return clarifyResult(taskId, rawGoal, resultText);
  }
  const shortened = shortenText(current.body);
  let updated;
  try {
    updated = await client.updateDraft(action.draftId, current.to, current.subject, shortened, current.cc, signal);
  } catch (e: any) {
    const resultText = `Could not revise the draft: ${e?.message ?? 'unknown error'}`;
    onEvent({ type: 'agent.failed', timestamp: Date.now(), taskId, data: { reason: resultText } });
    return { taskId, goal: rawGoal, status: 'failed', outcome: 'failed', result: resultText, steps: 0, tokensUsed: 0, actions: [], events: [], error: resultText, capability: { selected: 'gmail', reason: 'Draft revision failed.', readAttempted: false, browserFallbackUsed: false } };
  }
  // Same draftId — the pending send action still refers to the SAME real
  // draft object, now revised in place; never a second draft, never sent.
  pendingActionStore.set(sessionId, { type: 'gmail_send', draftId: action.draftId, recipient: action.recipient, subject: action.subject, createdAt: Date.now() });

  const resultText = `DRAFT REVISED (not sent)\n\nTo: ${updated.to.join(', ')}\nSubject: ${updated.subject}\nBody: ${updated.body}`;
  onEvent({ type: 'agent.completed', timestamp: Date.now(), taskId, data: { result: resultText, capability: 'gmail' } });
  return baseResult(taskId, rawGoal, resultText, {
    gmail: { operation: 'draft', pendingAction: { type: 'gmail_send', recipient: action.recipient, subject: action.subject, confirmationRequired: true } },
  });
}

/**
 * Returns null when `rawGoal` doesn't match a revision shape at all, OR
 * matches the shape but nothing pending exists that it could apply to —
 * both cases fall through to normal routing unchanged.
 */
export async function attemptProposalRevision(rawGoal: string, providedTaskId: string | undefined, onEvent: EventListener, signal: AbortSignal | undefined, sessionId: string): Promise<ExecutionResult | null> {
  const t = rawGoal.trim();
  const m = MAKE_THAT_RE.exec(t);
  if (m) {
    const change = m[1].trim();
    const clock = resolveClockTime(change) ?? resolveClockTime(`at ${change}`);
    const day = resolveDayPhrase(change);

    if (clock || day) {
      const calActive = !!calendarPendingActionStore.active(sessionId);
      const tasksActive = !!tasksPendingActionStore.active(sessionId);
      // A clock-time change only ever applies to Calendar (Tasks has no
      // time-of-day concept — see tasks/types.ts's own due-date-only note).
      const candidates: ('calendar' | 'tasks')[] = [];
      if (calActive) candidates.push('calendar');
      if (tasksActive && day && !clock) candidates.push('tasks');

      if (candidates.length === 0) return null;
      const taskId = providedTaskId || nanoid();
      if (candidates.length > 1) {
        return clarifyResult(taskId, rawGoal, 'I have a pending Calendar action and a pending Tasks action — which one should I change?');
      }
      return candidates[0] === 'calendar' ? reviseCalendar(rawGoal, taskId, onEvent, clock, day, sessionId) : reviseTasks(rawGoal, taskId, onEvent, day!, sessionId);
    }

    if (SHORTER_RE.test(change)) {
      if (!pendingActionStore.active(sessionId)) return null;
      const taskId = providedTaskId || nanoid();
      return reviseGmailShorter(rawGoal, taskId, onEvent, signal, sessionId);
    }
  }
  return null;
}
