/**
 * Checkpoint 29 — builds and executes reminder create/list/next/cancel
 * requests, and confirms/executes pending reminder proposals. Read
 * operations (list/next) touch only reminderStore's own read methods.
 * Creating or cancelling a persisted reminder is a MUTATION (§6/§7) — both
 * always go through reminderPendingActionStore's propose-then-confirm gate
 * exactly like Calendar/Gmail/Tasks; the initial request is NEVER treated
 * as authorization.
 *
 * §12 — reminder TEXT is untrusted data everywhere in this file: it is
 * only ever read (for display, or for a case-insensitive substring search
 * when cancelling), NEVER fed back into the task runner as a command, NEVER interpreted as a
 * command, NEVER used to fill a pending slot or mutate a different
 * capability's state.
 */

import { nanoid } from 'nanoid';
import type { ExecutionResult } from '@/core/agent/executor';
import type { EventListener } from '@/core/agent/events';
import type { ReminderIntent } from './intent';
import { parseReminderTrigger } from './datetime';
import { reminderStore } from './store';
import { reminderPendingActionStore, type ReminderCreateProposal, type ReminderCancelProposal } from './pending-action';
import { rearmScheduler } from './scheduler';
import type { Reminder } from './types';

const MAX_LISTED_REMINDERS = 20; // bounded — never an unlimited dump (§15)

function formatReminderLine(r: Reminder, index: number): string {
  return `${index + 1}. "${r.text}" — ${new Date(r.triggerAt).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`;
}

function completedResult(taskId: string, goal: string, resultText: string, onEvent: EventListener, extra?: Partial<ExecutionResult>): ExecutionResult {
  onEvent({ type: 'agent.completed', timestamp: Date.now(), taskId, data: { result: resultText, capability: 'reminders' as any } });
  return {
    taskId, goal, status: 'success', outcome: 'completed', result: resultText,
    steps: 0, tokensUsed: 0, actions: [], events: [],
    capability: { selected: 'reminders', reason: 'Recognized as a reminder request.', readAttempted: false, browserFallbackUsed: false },
    ...extra,
  };
}

function blockedResult(taskId: string, goal: string, resultText: string, onEvent: EventListener, reason: string): ExecutionResult {
  onEvent({ type: 'agent.completed', timestamp: Date.now(), taskId, data: { result: resultText, capability: 'reminders' as any } });
  return {
    taskId, goal, status: 'success', outcome: 'blocked', result: resultText,
    steps: 0, tokensUsed: 0, actions: [], events: [],
    capability: { selected: 'reminders', reason, readAttempted: false, browserFallbackUsed: false },
  };
}

export async function runReminderIntent(
  intent: ReminderIntent,
  onEvent: EventListener,
  signal: AbortSignal | undefined,
  sessionId: string,
  taskId: string,
  now: Date = new Date()
): Promise<ExecutionResult> {
  onEvent({ type: 'task.started', timestamp: Date.now(), taskId, data: { task: 'reminders', capability: 'reminders' as any } });

  if (intent.operation === 'list') {
    const scheduled = reminderStore.scheduledSorted();
    if (scheduled.length === 0) {
      return completedResult(taskId, intent.raw, "You don't have any scheduled reminders.", onEvent, { reminders: { operation: 'list', count: 0 } });
    }
    const bounded = scheduled.slice(0, MAX_LISTED_REMINDERS);
    const lines = bounded.map(formatReminderLine);
    let resultText = lines.join('\n');
    if (scheduled.length > bounded.length) resultText += `\n\n(Showing the next ${bounded.length} of ${scheduled.length}.)`;
    return completedResult(taskId, intent.raw, resultText, onEvent, { reminders: { operation: 'list', count: scheduled.length } });
  }

  if (intent.operation === 'next') {
    const scheduled = reminderStore.scheduledSorted();
    if (scheduled.length === 0) {
      return completedResult(taskId, intent.raw, "You don't have any scheduled reminders.", onEvent, { reminders: { operation: 'next', count: 0 } });
    }
    const next = scheduled[0];
    const resultText = `Your next reminder: "${next.text}" — ${new Date(next.triggerAt).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}.`;
    return completedResult(taskId, intent.raw, resultText, onEvent, { reminders: { operation: 'next', count: scheduled.length } });
  }

  if (intent.operation === 'create') {
    const parsed = parseReminderTrigger(intent.timePhrase!, now);
    if (parsed.kind === 'vague') {
      return blockedResult(
        taskId, intent.raw,
        'I can\'t schedule a reminder for a vague time like that — try something specific, like "in 20 minutes", "tomorrow at 9 AM", or "Friday at 3 PM."',
        onEvent, 'Reminder creation rejected — vague/unresolvable time phrase.'
      );
    }
    if (parsed.kind === 'past') {
      return blockedResult(
        taskId, intent.raw,
        'That time has already passed — I can\'t schedule a reminder in the past. Try including a day, like "tomorrow at 4 PM."',
        onEvent, 'Reminder creation rejected — resolved trigger time is in the past.'
      );
    }
    if (parsed.kind === 'none') {
      return blockedResult(
        taskId, intent.raw,
        'I couldn\'t figure out when to remind you — try something like "at 4 PM", "tomorrow morning", "in 20 minutes", or "Friday at 3 PM."',
        onEvent, 'Reminder creation rejected — no resolvable time phrase.'
      );
    }

    const proposal: ReminderCreateProposal = { text: intent.text!, triggerAt: parsed.triggerAt, label: parsed.label };
    reminderPendingActionStore.set(sessionId, { type: 'reminder_create', proposal, createdAt: Date.now() });
    const resultText = `I'll remind you ${parsed.label}:\n"${intent.text}"\n\nConfirm?`;
    return completedResult(taskId, intent.raw, resultText, onEvent, {
      reminders: { operation: 'propose_create', pendingAction: { type: 'reminder_create', text: proposal.text, triggerAt: proposal.triggerAt, confirmationRequired: true } },
    });
  }

  // cancel
  const query = intent.searchQuery!.toLowerCase();
  const matches = reminderStore.scheduledSorted().filter((r) => r.text.toLowerCase().includes(query));

  if (matches.length === 0) {
    return blockedResult(
      taskId, intent.raw,
      `I couldn't find a scheduled reminder matching "${intent.searchQuery}".`,
      onEvent, 'No scheduled reminder matched the cancellation request.'
    );
  }
  if (matches.length > 1) {
    return blockedResult(
      taskId, intent.raw,
      `I found ${matches.length} matching reminders. Which one?\n${matches.map(formatReminderLine).join('\n')}`,
      onEvent, 'Ambiguous reminder cancellation — multiple matches, never guessed.'
    );
  }

  const target = matches[0];
  const label = new Date(target.triggerAt).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const proposal: ReminderCancelProposal = { reminderId: target.id, text: target.text, triggerAt: target.triggerAt, label };
  reminderPendingActionStore.set(sessionId, { type: 'reminder_cancel', proposal, createdAt: Date.now() });
  const resultText = `I'll cancel your reminder "${target.text}" (${label}).\n\nConfirm?`;
  return completedResult(taskId, intent.raw, resultText, onEvent, {
    reminders: { operation: 'propose_cancel', pendingAction: { type: 'reminder_cancel', text: proposal.text, triggerAt: proposal.triggerAt, confirmationRequired: true } },
  });
}

/**
 * Confirms whatever reminder proposal (create or cancel) is currently
 * pending for this session. claim() is the atomic idempotency guard — a
 * racing second confirmation sees nothing left to claim, exactly the same
 * discipline as attemptCalendarConfirmation/attemptTasksConfirmation/
 * attemptGmailSendConfirmation in task-manager.ts. Creating/cancelling is
 * a plain local persistence write (no external client call, no network),
 * so there is no meaningful "abort mid-mutation" case the way a real API
 * call has — the mutation itself is synchronous and atomic at the store
 * level (see store.ts's own add()/cancel()).
 */
export async function attemptReminderConfirmation(
  goal: string,
  taskId: string,
  onEvent: EventListener,
  sessionId: string,
  now: Date = new Date()
): Promise<ExecutionResult> {
  onEvent({ type: 'task.started', timestamp: Date.now(), taskId, data: { task: goal, capability: 'reminders' as any } });

  const action = reminderPendingActionStore.claim(sessionId);
  if (!action) {
    const resultText = 'There is no pending reminder waiting to be confirmed (it may have already been completed, cancelled, or expired) — nothing changed.';
    return completedResult(taskId, goal, resultText, onEvent, { reminders: { operation: 'confirm_noop' } });
  }

  if (action.type === 'reminder_create') {
    const proposal = action.proposal as ReminderCreateProposal;
    const reminder: Reminder = { id: nanoid(), text: proposal.text, triggerAt: proposal.triggerAt, createdAt: now.toISOString(), status: 'scheduled' };
    reminderStore.add(reminder);
    rearmScheduler(now);
    const resultText = `Reminder set for ${proposal.label}: "${proposal.text}".`;
    return completedResult(taskId, goal, resultText, onEvent, {
      reminders: { operation: 'create', resultReminderId: reminder.id },
    });
  }

  const proposal = action.proposal as ReminderCancelProposal;
  const changed = reminderStore.cancel(proposal.reminderId, now);
  rearmScheduler(now);
  const resultText = changed
    ? `Cancelled your reminder "${proposal.text}".`
    : `That reminder was already cancelled or delivered — nothing changed.`;
  return completedResult(taskId, goal, resultText, onEvent, {
    reminders: { operation: 'cancel', resultReminderId: proposal.reminderId },
  });
}
