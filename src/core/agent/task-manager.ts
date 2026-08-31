import { BrowserController } from '@/core/browser/controller';
import { AgentExecutor, ExecutionResult } from './executor';
import { ContextManager } from '@/core/context';
import { SkillRegistry } from '@/skills/registry';
import { NavigationSkill } from '@/skills/navigation';
import { ExtractionSkill } from '@/skills/extraction';
import { InteractionSkill } from '@/skills/interaction';
import { SearchSkill } from '@/skills/search';
import { Planner } from './planner';
import { OmniRouteClient } from '@/core/router/client';
import { AgentEvent, EventListener } from './events';
import { routeCapability, type CapabilityDecision } from './capability-router';
import { resolveRead } from '@/core/capabilities/read';
import { classifyGoal } from './goal-state';
import { decomposeTask, validatePlan, type TaskPlan } from './subgoal';
import { runTaskPlan } from './subgoal-runner';
import { nanoid } from 'nanoid';
import { detectGmailIntent, isSendConfirmationPhrase, isUnambiguousSendPhrase, isSendCancelPhrase, isGmailSpecificCancelPhrase } from '@/core/capabilities/gmail/intent';
import { runGmailIntent } from '@/core/capabilities/gmail/runner';
import { getGmailClient, gmailAvailability } from '@/core/capabilities/gmail/resolve';
import { pendingActionStore } from '@/core/capabilities/gmail/pending-action';
import {
  detectCalendarIntent,
  unambiguousCalendarPhraseType,
  isAmbiguousCalendarConfirmPhrase,
  isCalendarRejectPhrase,
  isCalendarSpecificCancelPhrase,
} from '@/core/capabilities/calendar/intent';
import { runCalendarIntent } from '@/core/capabilities/calendar/runner';
import { getCalendarClient, calendarAvailability } from '@/core/capabilities/calendar/resolve';
import { calendarPendingActionStore, type CalendarPendingActionType } from '@/core/capabilities/calendar/pending-action';
import { formatLocal, resolveDayPhrase } from '@/core/capabilities/calendar/datetime';
import {
  detectTasksIntent,
  unambiguousTasksPhraseType,
  isAmbiguousTasksConfirmPhrase,
  isTasksRejectPhrase,
  isTasksSpecificCancelPhrase,
} from '@/core/capabilities/tasks/intent';
import { runTasksIntent } from '@/core/capabilities/tasks/runner';
import { getTasksClient, tasksAvailability } from '@/core/capabilities/tasks/resolve';
import { tasksPendingActionStore, type TasksPendingActionType } from '@/core/capabilities/tasks/pending-action';
import { formatDueDate } from '@/core/capabilities/tasks/datetime';
import { tryOrchestration } from './orchestrator';
import { isCancelAllPhrase, activePendingCapabilities, clearPending, describeAmbiguousCancel } from '@/core/capabilities/shared/multi-pending';
import { conversationContext } from './conversation-context';
import { isStartOverPhrase, resolveConversationContext } from './context-resolver';
import { attemptProposalRevision } from './proposal-revision';
import { parsePreferenceCommand } from '@/core/preferences/intent';
import { attemptPreferenceCommand } from '@/core/preferences/runner';
import { preferencesStore } from '@/core/preferences/store';
import { isUnsupportedPhoneCallIntent } from '@/core/capabilities/shared/unsupported-intent';

export interface RunTaskOptions {
  goal: string;
  onEvent: EventListener;
  signal?: AbortSignal;
  taskId?: string;
  /**
   * Checkpoint 22 fix — the opaque per-browser-tab/UI-session id (see
   * session.ts) every conversational-context and pending-action lookup in
   * this file is keyed by. Required, deliberately: an optional field with
   * an implicit default would silently re-create the exact cross-session
   * leak this checkpoint fixes the moment any caller forgot to pass one.
   * Every direct caller — the real HTTP route AND every test script — must
   * state its session explicitly.
   */
  sessionId: string;
}

/**
 * Attempt the read capability. Returns a completed ExecutionResult on
 * success, or null when the caller should fall back to the browser path —
 * never throws. Read is attempted AT MOST ONCE; there is no retry loop, so
 * this cannot spin.
 */
async function attemptRead(
  goal: string,
  taskId: string,
  decision: CapabilityDecision,
  onEvent: EventListener,
  signal?: AbortSignal
): Promise<{ result?: ExecutionResult; failure?: string }> {
  onEvent({ type: 'task.started', timestamp: Date.now(), taskId, data: { task: goal, capability: 'read' } });

  const outcome = await resolveRead(decision.readSource, decision.readUrl, decision.readMeta, signal);

  if (!outcome.ok) {
    return { failure: outcome.error };
  }

  const { result: retrieval } = outcome;
  const preview = retrieval.text.length > 2000 ? `${retrieval.text.slice(0, 2000)}…` : retrieval.text;
  const resultText = retrieval.title
    ? `Read ${retrieval.url} (${retrieval.title}):\n\n${preview}`
    : `Read ${retrieval.url}:\n\n${preview}`;

  onEvent({ type: 'agent.completed', timestamp: Date.now(), taskId, data: { result: resultText, capability: 'read' } });

  return {
    result: {
      taskId,
      goal,
      status: 'success',
      outcome: 'completed',
      result: resultText,
      steps: 0,
      tokensUsed: 0,
      actions: [`read:${retrieval.source} (${retrieval.url})`],
      events: [],
    },
  };
}

/**
 * Checkpoint 17 §9-10 — a confirmation/cancel phrase only means anything
 * while a real, non-expired PendingAction exists; task-manager.ts checks
 * that FIRST (below, in runTask) before ever calling this — a bare "yes"
 * with nothing pending falls straight through to normal routing, never
 * triggering a send. §16 idempotency: pendingActionStore.claim() is
 * atomic — a second confirmation racing in behind the first sees nothing
 * to claim and gets an honest "already sent" response, never a duplicate.
 */
async function attemptGmailSendConfirmation(goal: string, taskId: string, onEvent: EventListener, signal: AbortSignal | undefined, sessionId: string): Promise<ExecutionResult> {
  onEvent({ type: 'task.started', timestamp: Date.now(), taskId, data: { task: goal, capability: 'gmail' } });

  const action = pendingActionStore.claim(sessionId);
  if (!action) {
    const resultText = 'There is no pending email waiting to be sent (it may have already been sent, cancelled, or expired) — nothing was sent.';
    onEvent({ type: 'agent.completed', timestamp: Date.now(), taskId, data: { result: resultText, capability: 'gmail' } });
    return {
      taskId, goal, status: 'success', outcome: 'completed', result: resultText,
      steps: 0, tokensUsed: 0, actions: [], events: [],
      capability: { selected: 'gmail', reason: 'Confirmation phrase with no active pending send.', readAttempted: false, browserFallbackUsed: false },
      gmail: { operation: 'send' },
    };
  }

  // §17 — deliberately NO top-level "abort before calling sendDraft" short
  // circuit here: only client.sendDraft() itself (mock and real alike) can
  // correctly decide this, because it checks "already sent?" BEFORE
  // "aborted?" — a short circuit at this layer would have no way to know
  // the draft might already have been accepted by an EARLIER call, and
  // would incorrectly report "cancelled" for an email that was, in truth,
  // already sent. claim() above has already marked this action consumed
  // (so it can never be double-claimed regardless of what happens next).
  try {
    const client = getGmailClient();
    const { messageId } = await client.sendDraft(action.draftId, signal);
    const resultText = `Sent email to ${action.recipient.join(', ')} — subject: "${action.subject}".`;
    onEvent({ type: 'agent.completed', timestamp: Date.now(), taskId, data: { result: resultText, capability: 'gmail' } });
    return {
      taskId, goal, status: 'success', outcome: 'completed', result: resultText,
      steps: 0, tokensUsed: 0, actions: [`gmail:send (${action.draftId})`], events: [],
      capability: { selected: 'gmail', reason: 'Explicit send confirmation matched a pending Gmail send.', readAttempted: false, browserFallbackUsed: false },
      gmail: { operation: 'send', sentMessageId: messageId },
    };
  } catch (e: any) {
    // §17 — if the underlying call was genuinely aborted BEFORE Gmail
    // accepted it (not after — sendDraft() only ever throws pre-acceptance;
    // once it resolves, the send already happened and this catch block
    // isn't reached), report 'stopped' honestly rather than 'failed'.
    const aborted = e?.name === 'AbortError' || signal?.aborted;
    const resultText = aborted
      ? 'Cancelled while sending — the draft was not sent.'
      : `Failed to send the confirmed email: ${e?.message ?? 'unknown error'}`;
    onEvent(aborted
      ? { type: 'task.stopped', timestamp: Date.now(), taskId, data: { reason: 'user_cancelled' } }
      : { type: 'agent.failed', timestamp: Date.now(), taskId, data: { reason: resultText } });
    return {
      taskId, goal, status: aborted ? 'stopped' : 'failed', outcome: aborted ? undefined : 'failed', result: resultText,
      steps: 0, tokensUsed: 0, actions: [], events: [], error: aborted ? undefined : resultText,
      capability: { selected: 'gmail', reason: aborted ? 'Send cancelled before Gmail accepted it.' : 'Send confirmed but the send itself failed.', readAttempted: false, browserFallbackUsed: false },
      gmail: { operation: 'send' },
    };
  }
}

/**
 * Checkpoint 18 §9-10 — the Calendar analogue of attemptGmailSendConfirmation.
 * Same discipline: claim() is the atomic idempotency guard, the actual
 * mutation call (create/update/delete) is the ONLY place a real Calendar
 * state change happens, and an abort is only ever honored if the client
 * itself throws BEFORE that mutation is accepted — never claimed after.
 */
async function attemptCalendarConfirmation(goal: string, taskId: string, onEvent: EventListener, signal: AbortSignal | undefined, sessionId: string): Promise<ExecutionResult> {
  onEvent({ type: 'task.started', timestamp: Date.now(), taskId, data: { task: goal, capability: 'calendar' } });

  const action = calendarPendingActionStore.claim(sessionId);
  if (!action) {
    // Nothing was pending, so there's no way to know which operation the
    // stale/repeat phrase would have confirmed — omitting `calendar`
    // entirely is honest here; inventing an operation type would not be.
    const resultText = 'There is no pending calendar action waiting to be confirmed (it may have already been completed, cancelled, or expired) — nothing changed.';
    onEvent({ type: 'agent.completed', timestamp: Date.now(), taskId, data: { result: resultText, capability: 'calendar' } });
    return {
      taskId, goal, status: 'success', outcome: 'completed', result: resultText,
      steps: 0, tokensUsed: 0, actions: [], events: [],
      capability: { selected: 'calendar', reason: 'Confirmation phrase with no active pending calendar action.', readAttempted: false, browserFallbackUsed: false },
    };
  }

  try {
    const client = getCalendarClient();
    let resultText: string;
    let operation: 'create' | 'update' | 'delete';
    let resultEventId: string | undefined;

    if (action.type === 'calendar_create') {
      operation = 'create';
      const event = await client.createEvent(action.proposal, signal);
      resultEventId = event.id;
      resultText = `Created "${event.title}" — ${formatLocal(event.start, event.timezone)} to ${formatLocal(event.end, event.timezone)}.`;
    } else if (action.type === 'calendar_update') {
      operation = 'update';
      const event = await client.updateEvent(action.proposal.existingEventId!, action.proposal, signal);
      resultEventId = event.id;
      resultText = `Updated "${event.title}" — now ${formatLocal(event.start, event.timezone)} to ${formatLocal(event.end, event.timezone)}.`;
    } else {
      operation = 'delete';
      await client.deleteEvent(action.proposal.existingEventId!, signal);
      resultText = `Cancelled "${action.proposal.title}".`;
    }

    onEvent({ type: 'agent.completed', timestamp: Date.now(), taskId, data: { result: resultText, capability: 'calendar' } });
    return {
      taskId, goal, status: 'success', outcome: 'completed', result: resultText,
      steps: 0, tokensUsed: 0, actions: [`calendar:${operation} (${action.proposal.existingEventId ?? 'new'})`], events: [],
      capability: { selected: 'calendar', reason: 'Explicit confirmation matched a pending Calendar action.', readAttempted: false, browserFallbackUsed: false },
      calendar: { operation, resultEventId },
    };
  } catch (e: any) {
    const aborted = e?.name === 'AbortError' || signal?.aborted;
    const resultText = aborted
      ? 'Cancelled before the calendar change was accepted — nothing changed.'
      : `Failed to apply the confirmed calendar action: ${e?.message ?? 'unknown error'}`;
    onEvent(aborted
      ? { type: 'task.stopped', timestamp: Date.now(), taskId, data: { reason: 'user_cancelled' } }
      : { type: 'agent.failed', timestamp: Date.now(), taskId, data: { reason: resultText } });
    return {
      taskId, goal, status: aborted ? 'stopped' : 'failed', outcome: aborted ? undefined : 'failed', result: resultText,
      steps: 0, tokensUsed: 0, actions: [], events: [], error: aborted ? undefined : resultText,
      capability: { selected: 'calendar', reason: aborted ? 'Calendar action cancelled before it was accepted.' : 'Confirmed but the calendar call itself failed.', readAttempted: false, browserFallbackUsed: false },
    };
  }
}

/**
 * Checkpoint 20 §9-11 — the Tasks analogue of attemptCalendarConfirmation.
 * Same discipline: claim() is the atomic idempotency guard, the actual
 * mutation call (create/update/complete/delete) is the ONLY place a real
 * Tasks state change happens, and an abort is only ever honored if the
 * client itself throws BEFORE that mutation is accepted.
 */
async function attemptTasksConfirmation(goal: string, taskId: string, onEvent: EventListener, signal: AbortSignal | undefined, sessionId: string): Promise<ExecutionResult> {
  onEvent({ type: 'task.started', timestamp: Date.now(), taskId, data: { task: goal, capability: 'tasks' } });

  const action = tasksPendingActionStore.claim(sessionId);
  if (!action) {
    const resultText = 'There is no pending task action waiting to be confirmed (it may have already been completed, cancelled, or expired) — nothing changed.';
    onEvent({ type: 'agent.completed', timestamp: Date.now(), taskId, data: { result: resultText, capability: 'tasks' } });
    return {
      taskId, goal, status: 'success', outcome: 'completed', result: resultText,
      steps: 0, tokensUsed: 0, actions: [], events: [],
      capability: { selected: 'tasks', reason: 'Confirmation phrase with no active pending task action.', readAttempted: false, browserFallbackUsed: false },
    };
  }

  try {
    const client = getTasksClient();
    let resultText: string;
    let operation: 'create' | 'update' | 'complete' | 'delete';
    let resultTaskId: string | undefined;

    if (action.type === 'tasks_create') {
      operation = 'create';
      const created = await client.createTask(action.proposal, signal);
      resultTaskId = created.id;
      resultText = `Created "${created.title}"${created.due ? ` — due ${formatDueDate(created.due)}` : ''}.`;
    } else if (action.type === 'tasks_update') {
      operation = 'update';
      const updated = await client.updateTask(action.proposal, signal);
      resultTaskId = updated.id;
      resultText = `Updated "${updated.title}"${updated.due ? ` — now due ${formatDueDate(updated.due)}` : ''}.`;
    } else if (action.type === 'tasks_complete') {
      operation = 'complete';
      const completed = await client.completeTask(action.proposal.taskListId, action.proposal.existingTaskId!, signal);
      resultTaskId = completed.id;
      resultText = `Marked "${completed.title}" complete.`;
    } else {
      operation = 'delete';
      await client.deleteTask(action.proposal.taskListId, action.proposal.existingTaskId!, signal);
      resultText = `Deleted "${action.proposal.title}".`;
    }

    onEvent({ type: 'agent.completed', timestamp: Date.now(), taskId, data: { result: resultText, capability: 'tasks' } });
    return {
      taskId, goal, status: 'success', outcome: 'completed', result: resultText,
      steps: 0, tokensUsed: 0, actions: [`tasks:${operation} (${action.proposal.existingTaskId ?? 'new'})`], events: [],
      capability: { selected: 'tasks', reason: 'Explicit confirmation matched a pending Tasks action.', readAttempted: false, browserFallbackUsed: false },
      tasks: { operation, resultTaskId },
    };
  } catch (e: any) {
    const aborted = e?.name === 'AbortError' || signal?.aborted;
    const resultText = aborted
      ? 'Cancelled before the task change was accepted — nothing changed.'
      : `Failed to apply the confirmed task action: ${e?.message ?? 'unknown error'}`;
    onEvent(aborted
      ? { type: 'task.stopped', timestamp: Date.now(), taskId, data: { reason: 'user_cancelled' } }
      : { type: 'agent.failed', timestamp: Date.now(), taskId, data: { reason: resultText } });
    return {
      taskId, goal, status: aborted ? 'stopped' : 'failed', outcome: aborted ? undefined : 'failed', result: resultText,
      steps: 0, tokensUsed: 0, actions: [], events: [], error: aborted ? undefined : resultText,
      capability: { selected: 'tasks', reason: aborted ? 'Task action cancelled before it was accepted.' : 'Confirmed but the task call itself failed.', readAttempted: false, browserFallbackUsed: false },
    };
  }
}

/**
 * Checkpoint 20 §4-8 — the Tasks capability path. Every branch here is
 * read-only or proposal-only; createTask/updateTask/completeTask/deleteTask
 * are never reachable from this function (see attemptTasksConfirmation
 * above for the ONLY mutation path).
 */
async function attemptTasks(goal: string, taskId: string, onEvent: EventListener, signal: AbortSignal | undefined, sessionId: string): Promise<ExecutionResult> {
  onEvent({ type: 'task.started', timestamp: Date.now(), taskId, data: { task: goal, capability: 'tasks' } });

  const availability = tasksAvailability();
  if (!availability.available) {
    const resultText = availability.reason;
    onEvent({ type: 'agent.failed', timestamp: Date.now(), taskId, data: { reason: resultText } });
    return {
      taskId, goal, status: 'failed', outcome: 'failed', result: resultText,
      steps: 0, tokensUsed: 0, actions: [], events: [], error: resultText,
      capability: { selected: 'tasks', reason: 'Tasks capability matched but is not yet authorized.', readAttempted: false, browserFallbackUsed: false },
    };
  }

  if (signal?.aborted) {
    const resultText = 'Cancelled by user.';
    onEvent({ type: 'task.stopped', timestamp: Date.now(), taskId, data: { reason: 'user_cancelled' } });
    return {
      taskId, goal, status: 'stopped', result: resultText,
      steps: 0, tokensUsed: 0, actions: [], events: [],
      capability: { selected: 'tasks', reason: 'Cancelled before the Tasks operation started.', readAttempted: false, browserFallbackUsed: false },
    };
  }

  const intent = detectTasksIntent(goal)!; // caller already confirmed this is non-null
  try {
    const client = getTasksClient();
    const outcome = await runTasksIntent(intent, client, signal);

    if (outcome.status === 'stopped') {
      onEvent({ type: 'task.stopped', timestamp: Date.now(), taskId, data: { reason: 'user_cancelled' } });
      return {
        taskId, goal, status: 'stopped', result: outcome.resultText,
        steps: 0, tokensUsed: 0, actions: [`tasks:${intent.operation}`], events: [],
        capability: { selected: 'tasks', reason: 'Cancelled during the Tasks operation.', readAttempted: false, browserFallbackUsed: false },
        tasks: { operation: intent.operation },
      };
    }

    let pendingAction: { type: TasksPendingActionType; title: string; due?: string; confirmationRequired: true } | undefined;
    if (outcome.proposalCreated) {
      const type: TasksPendingActionType =
        outcome.proposalCreated.kind === 'create' ? 'tasks_create'
        : outcome.proposalCreated.kind === 'update' ? 'tasks_update'
        : outcome.proposalCreated.kind === 'complete' ? 'tasks_complete'
        : 'tasks_delete';
      const created = tasksPendingActionStore.set(sessionId, { type, proposal: outcome.proposalCreated.proposal, createdAt: Date.now() });
      pendingAction = { type, title: created.proposal.title, due: created.proposal.due, confirmationRequired: true };
    }

    const eventType = outcome.status === 'completed' ? 'agent.completed' : 'agent.failed';
    onEvent({ type: eventType, timestamp: Date.now(), taskId, data: { result: outcome.resultText, capability: 'tasks' } });

    return {
      taskId,
      goal,
      status: outcome.status === 'completed' ? 'success' : 'failed',
      outcome: outcome.status === 'completed' ? 'completed' : outcome.status === 'blocked' ? 'blocked' : 'failed',
      result: outcome.resultText,
      steps: 0,
      tokensUsed: 0,
      actions: [`tasks:${intent.operation}`],
      events: [],
      capability: { selected: 'tasks', reason: `Task names a Tasks ${intent.operation} operation.`, readAttempted: false, browserFallbackUsed: false },
      tasks: { operation: intent.operation, pendingAction },
    };
  } catch (e: any) {
    const aborted = e?.name === 'AbortError' || signal?.aborted;
    const resultText = aborted ? 'Cancelled by user.' : `Tasks operation failed: ${e?.message ?? 'unknown error'}`;
    onEvent(aborted
      ? { type: 'task.stopped', timestamp: Date.now(), taskId, data: { reason: 'user_cancelled' } }
      : { type: 'agent.failed', timestamp: Date.now(), taskId, data: { reason: resultText } });
    return {
      taskId, goal, status: aborted ? 'stopped' : 'failed', outcome: aborted ? undefined : 'failed', result: resultText,
      steps: 0, tokensUsed: 0, actions: [], events: [], error: aborted ? undefined : resultText,
      capability: { selected: 'tasks', reason: aborted ? 'Cancelled during the Tasks operation.' : 'Tasks operation threw.', readAttempted: false, browserFallbackUsed: false },
    };
  }
}

/**
 * Checkpoint 18 §4-8 — the Calendar capability path. Every branch here is
 * read-only or proposal-only; createEvent/updateEvent/deleteEvent are never
 * reachable from this function (see attemptCalendarConfirmation above for
 * the ONLY mutation path).
 */
async function attemptCalendar(goal: string, taskId: string, onEvent: EventListener, signal: AbortSignal | undefined, sessionId: string): Promise<ExecutionResult> {
  onEvent({ type: 'task.started', timestamp: Date.now(), taskId, data: { task: goal, capability: 'calendar' } });

  const availability = calendarAvailability();
  if (!availability.available) {
    const resultText = availability.reason;
    onEvent({ type: 'agent.failed', timestamp: Date.now(), taskId, data: { reason: resultText } });
    return {
      taskId, goal, status: 'failed', outcome: 'failed', result: resultText,
      steps: 0, tokensUsed: 0, actions: [], events: [], error: resultText,
      capability: { selected: 'calendar', reason: 'Calendar capability matched but is not yet authorized.', readAttempted: false, browserFallbackUsed: false },
    };
  }

  if (signal?.aborted) {
    const resultText = 'Cancelled by user.';
    onEvent({ type: 'task.stopped', timestamp: Date.now(), taskId, data: { reason: 'user_cancelled' } });
    return {
      taskId, goal, status: 'stopped', result: resultText,
      steps: 0, tokensUsed: 0, actions: [], events: [],
      capability: { selected: 'calendar', reason: 'Cancelled before the Calendar operation started.', readAttempted: false, browserFallbackUsed: false },
    };
  }

  // Checkpoint 23 §7-8 — a stored duration preference only ever fills in
  // for a duration THIS command never stated; detectCalendarIntent/
  // resolveCreateTiming already give explicit text absolute priority (see
  // calendar/intent.ts's resolveCreateTiming). Preferences are never keyed
  // by sessionId — read fresh from the one local preference file.
  const preferredDuration = preferencesStore.get('meetingDurationMinutes');
  const intent = detectCalendarIntent(goal, preferredDuration)!; // caller already confirmed this is non-null
  try {
    const client = getCalendarClient();
    const outcome = await runCalendarIntent(intent, client, signal);

    if (outcome.status === 'stopped') {
      onEvent({ type: 'task.stopped', timestamp: Date.now(), taskId, data: { reason: 'user_cancelled' } });
      return {
        taskId, goal, status: 'stopped', result: outcome.resultText,
        steps: 0, tokensUsed: 0, actions: [`calendar:${intent.operation}`], events: [],
        capability: { selected: 'calendar', reason: 'Cancelled during the Calendar operation.', readAttempted: false, browserFallbackUsed: false },
        calendar: { operation: intent.operation },
      };
    }

    let pendingAction: { type: CalendarPendingActionType; title: string; start: string; confirmationRequired: true } | undefined;
    if (outcome.proposalCreated) {
      const type: CalendarPendingActionType =
        outcome.proposalCreated.kind === 'create' ? 'calendar_create' : outcome.proposalCreated.kind === 'update' ? 'calendar_update' : 'calendar_delete';
      const created = calendarPendingActionStore.set(sessionId, { type, proposal: outcome.proposalCreated.proposal, createdAt: Date.now() });
      pendingAction = { type, title: created.proposal.title, start: created.proposal.start, confirmationRequired: true };
    }

    const eventType = outcome.status === 'completed' ? 'agent.completed' : 'agent.failed';
    onEvent({ type: eventType, timestamp: Date.now(), taskId, data: { result: outcome.resultText, capability: 'calendar' } });

    return {
      taskId,
      goal,
      status: outcome.status === 'completed' ? 'success' : 'failed',
      outcome: outcome.status === 'completed' ? 'completed' : outcome.status === 'blocked' ? 'blocked' : 'failed',
      result: outcome.resultText,
      steps: 0,
      tokensUsed: 0,
      actions: [`calendar:${intent.operation}`],
      events: [],
      capability: { selected: 'calendar', reason: `Task names a Calendar ${intent.operation} operation.`, readAttempted: false, browserFallbackUsed: false },
      calendar: { operation: intent.operation, pendingAction },
      resolution: outcome.resolution,
    };
  } catch (e: any) {
    const aborted = e?.name === 'AbortError' || signal?.aborted;
    const resultText = aborted ? 'Cancelled by user.' : `Calendar operation failed: ${e?.message ?? 'unknown error'}`;
    onEvent(aborted
      ? { type: 'task.stopped', timestamp: Date.now(), taskId, data: { reason: 'user_cancelled' } }
      : { type: 'agent.failed', timestamp: Date.now(), taskId, data: { reason: resultText } });
    return {
      taskId, goal, status: aborted ? 'stopped' : 'failed', outcome: aborted ? undefined : 'failed', result: resultText,
      steps: 0, tokensUsed: 0, actions: [], events: [], error: aborted ? undefined : resultText,
      capability: { selected: 'calendar', reason: aborted ? 'Cancelled during the Calendar operation.' : 'Calendar operation threw.', readAttempted: false, browserFallbackUsed: false },
    };
  }
}

/**
 * Checkpoint 17 §6-8 — the Gmail capability path. Every non-send operation
 * here is read-only or draft-only; sendDraft() is never reachable from this
 * function (see attemptGmailSendConfirmation above for the ONLY send path).
 */
async function attemptGmail(goal: string, taskId: string, onEvent: EventListener, signal: AbortSignal | undefined, sessionId: string): Promise<ExecutionResult> {
  onEvent({ type: 'task.started', timestamp: Date.now(), taskId, data: { task: goal, capability: 'gmail' } });

  const availability = gmailAvailability();
  if (!availability.available) {
    const resultText = availability.reason;
    onEvent({ type: 'agent.failed', timestamp: Date.now(), taskId, data: { reason: resultText } });
    return {
      taskId, goal, status: 'failed', outcome: 'failed', result: resultText,
      steps: 0, tokensUsed: 0, actions: [], events: [], error: resultText,
      capability: { selected: 'gmail', reason: 'Gmail capability matched but is not yet authorized.', readAttempted: false, browserFallbackUsed: false },
    };
  }

  // §17 — cancellation requested before this operation even started.
  if (signal?.aborted) {
    const resultText = 'Cancelled by user.';
    onEvent({ type: 'task.stopped', timestamp: Date.now(), taskId, data: { reason: 'user_cancelled' } });
    return {
      taskId, goal, status: 'stopped', result: resultText,
      steps: 0, tokensUsed: 0, actions: [], events: [],
      capability: { selected: 'gmail', reason: 'Cancelled before the Gmail operation started.', readAttempted: false, browserFallbackUsed: false },
    };
  }

  const intent = detectGmailIntent(goal)!; // caller already confirmed this is non-null
  try {
    const client = getGmailClient();
    const outcome = await runGmailIntent(intent, client, signal);

    if (outcome.status === 'stopped') {
      onEvent({ type: 'task.stopped', timestamp: Date.now(), taskId, data: { reason: 'user_cancelled' } });
      return {
        taskId, goal, status: 'stopped', result: outcome.resultText,
        steps: 0, tokensUsed: outcome.tokens, actions: [`gmail:${intent.operation}`], events: [],
        capability: { selected: 'gmail', reason: 'Cancelled during the Gmail operation.', readAttempted: false, browserFallbackUsed: false },
        gmail: { operation: intent.operation },
      };
    }

    let pendingAction: { type: 'gmail_send'; recipient: string[]; subject: string; confirmationRequired: true } | undefined;
    if (outcome.draftCreated) {
      const created = pendingActionStore.set(sessionId, {
        type: 'gmail_send',
        draftId: outcome.draftCreated.draftId,
        recipient: outcome.draftCreated.recipients,
        subject: outcome.draftCreated.subject,
        createdAt: Date.now(),
      });
      pendingAction = { type: 'gmail_send', recipient: created.recipient, subject: created.subject, confirmationRequired: true };
    }

    const eventType = outcome.status === 'completed' ? 'agent.completed' : 'agent.failed';
    onEvent({ type: eventType, timestamp: Date.now(), taskId, data: { result: outcome.resultText, capability: 'gmail' } });

    return {
      taskId,
      goal,
      status: outcome.status === 'completed' ? 'success' : 'failed',
      outcome: outcome.status === 'completed' ? 'completed' : outcome.status === 'blocked' ? 'blocked' : 'failed',
      result: outcome.resultText,
      steps: 0,
      tokensUsed: outcome.tokens,
      actions: [`gmail:${intent.operation}`],
      events: [],
      capability: { selected: 'gmail', reason: `Task names a Gmail ${intent.operation} operation.`, readAttempted: false, browserFallbackUsed: false },
      gmail: { operation: intent.operation, pendingAction },
      resolution: outcome.resolution,
    };
  } catch (e: any) {
    const aborted = e?.name === 'AbortError' || signal?.aborted;
    const resultText = aborted ? 'Cancelled by user.' : `Gmail operation failed: ${e?.message ?? 'unknown error'}`;
    onEvent(aborted
      ? { type: 'task.stopped', timestamp: Date.now(), taskId, data: { reason: 'user_cancelled' } }
      : { type: 'agent.failed', timestamp: Date.now(), taskId, data: { reason: resultText } });
    return {
      taskId, goal, status: aborted ? 'stopped' : 'failed', outcome: aborted ? undefined : 'failed', result: resultText,
      steps: 0, tokensUsed: 0, actions: [], events: [], error: aborted ? undefined : resultText,
      capability: { selected: 'gmail', reason: aborted ? 'Cancelled during the Gmail operation.' : 'Gmail operation threw.', readAttempted: false, browserFallbackUsed: false },
    };
  }
}

/**
 * Checkpoint 21 — wraps a matched OrchestrationResult into the same
 * ExecutionResult shape single-capability paths return. Every mutation a
 * step produced already went through its own capability's REAL
 * PendingAction store (see orchestrator.ts) — this function only reports;
 * it never itself creates, sends, or confirms anything.
 */
async function attemptOrchestration(goal: string, taskId: string, onEvent: EventListener, signal: AbortSignal | undefined, orchestration: NonNullable<Awaited<ReturnType<typeof tryOrchestration>>>): Promise<ExecutionResult> {
  const eventType = orchestration.status === 'failed' ? 'agent.failed' : 'agent.completed';
  onEvent({ type: eventType, timestamp: Date.now(), taskId, data: { result: orchestration.summaryText, capability: 'orchestration' as any } });

  return {
    taskId,
    goal,
    status: orchestration.status === 'failed' ? 'failed' : 'success',
    outcome: orchestration.status === 'completed' ? 'completed' : orchestration.status === 'failed' ? 'failed' : 'blocked',
    result: orchestration.summaryText,
    steps: 0,
    tokensUsed: 0,
    // Checkpoint 21 fix — a step's `status` alone can misleadingly read as
    // "nothing real happened" (a Gmail draft step is 'pending_confirmation',
    // same as a purely in-memory Calendar/Tasks proposal) even though it
    // already performed a real backend write (see OrchestrationStepResult.
    // remoteWriteOccurred's own comment). Tagged explicitly here so nothing
    // downstream can honestly claim "zero real mutations" when a real
    // Gmail draft was created.
    actions: orchestration.steps.map((s) => `${s.capability}:${s.id} (${s.status}${s.remoteWriteOccurred ? ', REMOTE WRITE OCCURRED' : ''})`),
    events: [],
    capability: { selected: 'orchestration', reason: `Orchestrated multi-step request (pattern: ${orchestration.pattern}).`, readAttempted: false, browserFallbackUsed: false },
    orchestration: { pattern: orchestration.pattern, status: orchestration.status, steps: orchestration.steps },
  };
}

/**
 * Checkpoint 22 — builds the minimal, privacy-safe conversational-context
 * snapshot from a completed turn's own already-typed result fields
 * (never re-reads retrieved content) and pushes it for the NEXT turn's
 * follow-up resolution. Runs after every turn that touched a capability;
 * a browser/read result doesn't feed conversational context in this
 * checkpoint (out of scope — only Gmail/Calendar/Tasks/orchestration
 * follow-ups are supported).
 */
function updateContextFromResult(effectiveGoal: string, result: ExecutionResult, sessionId: string): void {
  const cap = result.capability?.selected;
  if (cap !== 'calendar' && cap !== 'gmail' && cap !== 'tasks' && cap !== 'orchestration') return;

  let operation = 'unknown';
  if (result.calendar) operation = result.calendar.operation;
  else if (result.tasks) operation = result.tasks.operation;
  else if (result.gmail) operation = result.gmail.operation;
  else if (result.orchestration) operation = result.orchestration.pattern;

  const day = resolveDayPhrase(effectiveGoal);
  const dateRef = day ? { daysFromNow: day.daysFromNow, label: day.label } : undefined;

  const contactRef = result.resolution
    ? {
        query: result.resolution.query,
        email: result.resolution.status === 'resolved' ? result.resolution.email : undefined,
        ambiguous: result.resolution.status === 'ambiguous' || result.resolution.status === 'ambiguous_email',
      }
    : undefined;

  conversationContext.push(sessionId, { capability: cap, operation, dateRef, contactRef });
}

export async function runTask(options: RunTaskOptions): Promise<ExecutionResult> {
  const rawGoal = options.goal;
  const { onEvent, signal, taskId: providedTaskId, sessionId } = options;

  // Checkpoint 22 fix — deterministic, request-scoped cleanup: every turn
  // sweeps expired entries out of every session-keyed store (conversational
  // context and all three PendingAction stores) so the underlying Maps
  // cannot grow forever as sessions come and go. No background timer —
  // pruning ties to real traffic, which keeps it trivially deterministic
  // to test (see test-checkpoint22-session-isolation.ts's pruning cases).
  conversationContext.pruneAllExpired();
  pendingActionStore.pruneExpired();
  calendarPendingActionStore.pruneExpired();
  tasksPendingActionStore.pruneExpired();

  // Checkpoint 22 §"Context expiry/reset" — "Forget that."/"Start over."
  // clears ONLY the new conversational-reference state (dateRef/
  // contactRef/etc) for THIS session — never real Gmail/Calendar/Tasks
  // data, never another session's context, and deliberately never a
  // capability's own PendingAction store either (those already have their
  // own explicit, separate cancel mechanism from Checkpoint 21 —
  // conflating the two would let a vague "start over" accidentally clear a
  // real pending mutation the user never explicitly rejected).
  if (isStartOverPhrase(rawGoal)) {
    const taskId = providedTaskId || nanoid();
    conversationContext.clear(sessionId);
    const resultText = 'Cleared conversational context — starting fresh. (Any pending Gmail/Calendar/Tasks confirmation, if you have one, is untouched — cancel it explicitly if you want that gone too.)';
    onEvent({ type: 'agent.completed', timestamp: Date.now(), taskId, data: { result: resultText, capability: 'orchestration' as any } });
    return {
      taskId, goal: rawGoal, status: 'success', outcome: 'completed', result: resultText,
      steps: 0, tokensUsed: 0, actions: [], events: [],
      capability: { selected: 'orchestration', reason: 'Explicit reset of conversational context.', readAttempted: false, browserFallbackUsed: false },
    };
  }

  // Checkpoint 23 — explicit User Preferences commands ("Remember that I
  // prefer 30 minute meetings.", "What do you remember about my
  // preferences?", "Forget my email style preference."). Deliberately
  // checked here, on the RAW top-level user command only — never on
  // retrieved Gmail/Calendar/Tasks/browser content (see preferences/
  // intent.ts's module comment for why that's what keeps prompt injection
  // out). Persistent and NOT keyed by sessionId (see preferences/store.ts's
  // module comment on the session-vs-preferences distinction) — a reload's
  // brand-new CP22 session still sees the same preferences, by design.
  // parsePreferenceCommand()'s vocabulary is narrow enough that an ordinary
  // capability command ("Schedule a 45 minute meeting tomorrow.") never
  // matches and returns null, falling straight through unaffected.
  const preferenceCommand = parsePreferenceCommand(rawGoal);
  if (preferenceCommand) {
    const taskId = providedTaskId || nanoid();
    return attemptPreferenceCommand(rawGoal, taskId, onEvent, preferenceCommand);
  }

  // Checkpoint 22 — conversational revision of an EXISTING pending
  // proposal ("Make that 3 PM", "Make it shorter") operates directly on
  // pending state; it never goes through goal-rewriting since it edits a
  // structured proposal object, not natural language. Checked before
  // context resolution/routing since its trigger vocabulary ("make
  // that/it X") doesn't collide with anything else.
  const revision = await attemptProposalRevision(rawGoal, providedTaskId, onEvent, signal, sessionId);
  if (revision) return revision;

  // Checkpoint 22 — bounded reference resolution (pronouns, "what about
  // Friday?"-style date follow-ups). May rewrite the goal into a fully-
  // specified command for the EXISTING routing below to parse normally,
  // or block with an explicit clarification (never a guess) — see
  // context-resolver.ts. Returns null far more often than not, in which
  // case the ORIGINAL goal text proceeds completely unchanged.
  const contextResolution = resolveConversationContext(rawGoal, sessionId);
  if (contextResolution?.blocked) {
    const taskId = providedTaskId || nanoid();
    onEvent({ type: 'agent.completed', timestamp: Date.now(), taskId, data: { result: contextResolution.blocked, capability: 'orchestration' as any } });
    return {
      taskId, goal: rawGoal, status: 'success', outcome: 'blocked', result: contextResolution.blocked,
      steps: 0, tokensUsed: 0, actions: [], events: [],
      capability: { selected: 'orchestration', reason: 'Ambiguous or unresolved conversational reference.', readAttempted: false, browserFallbackUsed: false },
    };
  }
  const effectiveGoal = contextResolution?.rewrittenGoal ?? rawGoal;

  const result = await runTaskCore({ ...options, goal: effectiveGoal });
  updateContextFromResult(effectiveGoal, result, sessionId);
  // The user's OWN words are what gets reported/logged, not the internal
  // rewrite — same discipline voice normalization already uses elsewhere.
  return { ...result, goal: rawGoal };
}

async function runTaskCore(options: RunTaskOptions): Promise<ExecutionResult> {
  const { goal, onEvent, signal, taskId: providedTaskId, sessionId } = options;
  console.log(`[integrity] runTask.task=${JSON.stringify(goal)} len=${goal.length}`);

  // Checkpoint 17/18/20 §9 — UNAMBIGUOUS phrases ("send it", "create it",
  // "update it", "cancel it", "mark it complete") are checked regardless of
  // whether anything is currently pending — their own vocabulary names the
  // action, so a STALE or REPEATED confirmation still gets an honest
  // "nothing pending" answer instead of silently falling through to
  // unrelated browser routing. Gmail's vocabulary ("send it") is disjoint
  // from Calendar's and Tasks'. Calendar's and Tasks' vocabularies
  // DELIBERATELY overlap ("create it"/"update it"/"delete it" — the spec's
  // own §9 examples use "Create it."/"Delete it." for Tasks too), so those
  // two are resolved together via the exactly-one-active tiebreak below
  // rather than a fixed priority order — never guessing which capability a
  // shared phrase refers to.
  const gmailPendingActive = !!pendingActionStore.active(sessionId);
  const calendarPendingActive = !!calendarPendingActionStore.active(sessionId);
  const tasksPendingActive = !!tasksPendingActionStore.active(sessionId);

  // Checkpoint 22 fix — a confirm phrase is only genuinely UNAMBIGUOUS when
  // it names the SAME action type as what's actually pending. Caught via
  // careful review while wiring CP22's new "cancel it"/"cancel that"
  // rejection phrasing: unambiguousCalendarPhraseType("cancel it") returns
  // 'calendar_delete' unconditionally, but attemptCalendarConfirmation
  // executes whatever the STORED pending action's own .type says — so
  // "Cancel it." against a pending calendar_create proposal (e.g. from
  // "Schedule a meeting...") would have been silently treated as an
  // unambiguous CONFIRM and actually CREATED the event, exactly backwards
  // from the user's evident intent to reject it. When the phrase's implied
  // type doesn't match what's actually pending, it's no longer
  // unambiguous — falls through to the reject/ambiguous tier below, where
  // "cancel it" is now correctly recognized as a REJECTION instead. When
  // NOTHING is pending at all, the phrase still passes through unchanged
  // so the existing honest "nothing pending" report is preserved exactly.
  // Post-CP23 fix — a second, narrower gap in the same family: when
  // NOTHING is pending for THIS capability, the two guards below used to
  // claim the phrase unconditionally (to preserve the honest "nothing
  // pending" report for a genuinely stale/repeated confirm). But "cancel
  // it"/"cancel that" is not calendar-exclusive vocabulary the way "book
  // it"/"schedule it" is — it's the SAME shared reject wording
  // isCalendarRejectPhrase/isTasksRejectPhrase/isSendCancelPhrase already
  // recognize below. Caught live: a pending TASKS proposal + "Cancel it."
  // was being unconditionally claimed by CALENDAR's own top-tier dispatch
  // (nothing calendar-specific was pending, so the old guard fell back to
  // "claim it anyway") and reported calendar's "nothing pending" message
  // — while the real Tasks proposal sat there, still armed. Fixed by
  // deferring (returning null) whenever the exact phrase is ALSO
  // recognized shared reject vocabulary AND something else IS pending
  // elsewhere — letting the ambiguous-reject tier below, which already
  // resolves via activePendingCapabilities(), correctly identify and act
  // on whatever capability actually has something pending. Only applies
  // to that shared-reject-word case; "create it"/"book it"/"update it"/
  // bare "delete it" — words the reject-phrase checkers don't recognize —
  // are entirely unaffected and keep their exact prior behavior.
  function isSharedRejectWord(text: string): boolean {
    return isCalendarRejectPhrase(text) || isTasksRejectPhrase(text) || isSendCancelPhrase(text);
  }
  function calendarPhraseMatchesPending(phraseType: CalendarPendingActionType | null): CalendarPendingActionType | null {
    if (!phraseType) return null;
    const active = calendarPendingActionStore.active(sessionId);
    if (active) return active.type === phraseType ? phraseType : null;
    if (isSharedRejectWord(goal) && activePendingCapabilities(sessionId).length > 0) return null;
    return phraseType;
  }
  function tasksPhraseMatchesPending(phraseType: TasksPendingActionType | null): TasksPendingActionType | null {
    if (!phraseType) return null;
    const active = tasksPendingActionStore.active(sessionId);
    if (active) return active.type === phraseType ? phraseType : null;
    if (isSharedRejectWord(goal) && activePendingCapabilities(sessionId).length > 0) return null;
    return phraseType;
  }

  const calendarPhraseType = calendarPhraseMatchesPending(unambiguousCalendarPhraseType(goal));
  const tasksPhraseType = tasksPhraseMatchesPending(unambiguousTasksPhraseType(goal));
  if (calendarPhraseType || tasksPhraseType) {
    if (calendarPhraseType && tasksPhraseType) {
      // Shared vocabulary ("create it"/"update it"/"delete it") — resolve
      // via which store is actually active. Neither active preserves the
      // PRE-Checkpoint-20 behavior exactly (Calendar owned this vocabulary
      // first, and its regression tests assert this exact "nothing
      // pending" wording) — a genuine ambiguity (both active at once) is
      // not resolved here at all, matching the bare-word tiebreak's own
      // "don't guess" rule below.
      if (tasksPendingActive && !calendarPendingActive) {
        const taskId = providedTaskId || nanoid();
        return attemptTasksConfirmation(goal, taskId, onEvent, signal, sessionId);
      }
      if (!(calendarPendingActive && tasksPendingActive)) {
        const taskId = providedTaskId || nanoid();
        return attemptCalendarConfirmation(goal, taskId, onEvent, signal, sessionId);
      }
      // both active — genuinely ambiguous, fall through to unrelated routing.
    } else if (calendarPhraseType) {
      const taskId = providedTaskId || nanoid();
      return attemptCalendarConfirmation(goal, taskId, onEvent, signal, sessionId);
    } else {
      const taskId = providedTaskId || nanoid();
      return attemptTasksConfirmation(goal, taskId, onEvent, signal, sessionId);
    }
  }
  if (isUnambiguousSendPhrase(goal)) {
    const taskId = providedTaskId || nanoid();
    return attemptGmailSendConfirmation(goal, taskId, onEvent, signal, sessionId);
  }

  // AMBIGUOUS bare words ("yes", "confirm", "go ahead") share vocabulary
  // across all three capabilities by necessity — only ever treated as a
  // confirmation when EXACTLY ONE of the three pending stores is active; if
  // more than one happens to be active at once (rare — two different
  // capabilities mid-confirmation simultaneously), a bare word is genuinely
  // ambiguous and is NOT resolved here — §6/§9's "do not guess" applies to
  // which capability it refers to, not just to dates/times.
  if (isAmbiguousCalendarConfirmPhrase(goal) || isSendConfirmationPhrase(goal) || isAmbiguousTasksConfirmPhrase(goal)) {
    const activeCount = [gmailPendingActive, calendarPendingActive, tasksPendingActive].filter(Boolean).length;
    if (activeCount === 1) {
      if (calendarPendingActive) {
        const taskId = providedTaskId || nanoid();
        return attemptCalendarConfirmation(goal, taskId, onEvent, signal, sessionId);
      }
      if (gmailPendingActive) {
        const taskId = providedTaskId || nanoid();
        return attemptGmailSendConfirmation(goal, taskId, onEvent, signal, sessionId);
      }
      if (tasksPendingActive) {
        const taskId = providedTaskId || nanoid();
        return attemptTasksConfirmation(goal, taskId, onEvent, signal, sessionId);
      }
    }
    // more than one or none active — fall through; no capability claims an
    // ambiguous bare word it can't uniquely resolve.
  }

  // Checkpoint 21 fix — capability-UNAMBIGUOUS cancel phrases (the phrase's
  // own noun names the capability specifically — "cancel the meeting",
  // "cancel the email") are checked FIRST, unconditionally: needed because
  // orchestration Pattern 3 can leave a Calendar proposal AND a Gmail
  // draft pending SIMULTANEOUSLY, something no single-capability flow
  // could produce before this checkpoint, and the old bare-word tier below
  // requires exactly one store active to act on anything at all — it could
  // never clear just one half of a dual-pending state.
  if (isCancelAllPhrase(goal)) {
    const active = activePendingCapabilities(sessionId);
    if (active.length > 0) {
      for (const cap of active) clearPending(sessionId, cap);
      const taskId = providedTaskId || nanoid();
      const resultText = `Cancelled ${active.map((c) => (c === 'calendar' ? 'the calendar change' : c === 'gmail' ? 'the email draft' : 'the task change')).join(' and ')} — nothing was changed.`;
      onEvent({ type: 'agent.completed', timestamp: Date.now(), taskId, data: { result: resultText, capability: 'orchestration' as any } });
      return {
        taskId, goal, status: 'success', outcome: 'completed', result: resultText,
        steps: 0, tokensUsed: 0, actions: [], events: [],
        capability: { selected: 'orchestration', reason: 'Explicit cancellation of all pending actions.', readAttempted: false, browserFallbackUsed: false },
      };
    }
    // nothing was pending — fall through to normal routing, same as the ambiguous tier's zero-active case below.
  }
  if (isCalendarSpecificCancelPhrase(goal) && calendarPendingActive) {
    calendarPendingActionStore.clear(sessionId);
    const taskId = providedTaskId || nanoid();
    const resultText = 'Cancelled — the calendar change was not made.';
    onEvent({ type: 'agent.completed', timestamp: Date.now(), taskId, data: { result: resultText, capability: 'calendar' } });
    return {
      taskId, goal, status: 'success', outcome: 'completed', result: resultText,
      steps: 0, tokensUsed: 0, actions: [], events: [],
      capability: { selected: 'calendar', reason: 'Explicit cancellation of a pending Calendar action.', readAttempted: false, browserFallbackUsed: false },
    };
  }
  if (isGmailSpecificCancelPhrase(goal) && gmailPendingActive) {
    pendingActionStore.clear(sessionId);
    const taskId = providedTaskId || nanoid();
    const resultText = 'Cancelled — the draft was not sent.';
    onEvent({ type: 'agent.completed', timestamp: Date.now(), taskId, data: { result: resultText, capability: 'gmail' } });
    return {
      taskId, goal, status: 'success', outcome: 'completed', result: resultText,
      steps: 0, tokensUsed: 0, actions: [], events: [],
      capability: { selected: 'gmail', reason: 'Explicit cancellation of a pending Gmail send.', readAttempted: false, browserFallbackUsed: false },
      gmail: { operation: 'send' },
    };
  }
  if (isTasksSpecificCancelPhrase(goal) && tasksPendingActive) {
    tasksPendingActionStore.clear(sessionId);
    const taskId = providedTaskId || nanoid();
    const resultText = 'Cancelled — the task change was not made.';
    onEvent({ type: 'agent.completed', timestamp: Date.now(), taskId, data: { result: resultText, capability: 'tasks' } });
    return {
      taskId, goal, status: 'success', outcome: 'completed', result: resultText,
      steps: 0, tokensUsed: 0, actions: [], events: [],
      capability: { selected: 'tasks', reason: 'Explicit cancellation of a pending Tasks action.', readAttempted: false, browserFallbackUsed: false },
    };
  }

  // Ambiguous/bare reject vocabulary ("no", "stop", "never mind", "don't
  // create it", plain "cancel") is shared across all three capabilities by
  // necessity — same "exactly one active" idea as the confirm side above,
  // but now explicit about the 2+-active case instead of silently falling
  // through: §9's "do not guess" applies to cancellation exactly as much
  // as to confirmation. Checked only after the unambiguous, noun-specific
  // phrases above already had their chance.
  const isAmbiguousCancel = isCalendarRejectPhrase(goal) || isTasksRejectPhrase(goal) || isSendCancelPhrase(goal);
  if (isAmbiguousCancel) {
    const active = activePendingCapabilities(sessionId);
    if (active.length === 1) {
      const cap = active[0];
      const taskId = providedTaskId || nanoid();
      if (cap === 'calendar') {
        calendarPendingActionStore.clear(sessionId);
        const resultText = 'Cancelled — the calendar change was not made.';
        onEvent({ type: 'agent.completed', timestamp: Date.now(), taskId, data: { result: resultText, capability: 'calendar' } });
        return {
          taskId, goal, status: 'success', outcome: 'completed', result: resultText,
          steps: 0, tokensUsed: 0, actions: [], events: [],
          capability: { selected: 'calendar', reason: 'Explicit cancellation of a pending Calendar action.', readAttempted: false, browserFallbackUsed: false },
        };
      }
      if (cap === 'gmail') {
        pendingActionStore.clear(sessionId);
        const resultText = 'Cancelled — the draft was not sent.';
        onEvent({ type: 'agent.completed', timestamp: Date.now(), taskId, data: { result: resultText, capability: 'gmail' } });
        return {
          taskId, goal, status: 'success', outcome: 'completed', result: resultText,
          steps: 0, tokensUsed: 0, actions: [], events: [],
          capability: { selected: 'gmail', reason: 'Explicit cancellation of a pending Gmail send.', readAttempted: false, browserFallbackUsed: false },
          gmail: { operation: 'send' },
        };
      }
      tasksPendingActionStore.clear(sessionId);
      const resultText = 'Cancelled — the task change was not made.';
      onEvent({ type: 'agent.completed', timestamp: Date.now(), taskId, data: { result: resultText, capability: 'tasks' } });
      return {
        taskId, goal, status: 'success', outcome: 'completed', result: resultText,
        steps: 0, tokensUsed: 0, actions: [], events: [],
        capability: { selected: 'tasks', reason: 'Explicit cancellation of a pending Tasks action.', readAttempted: false, browserFallbackUsed: false },
      };
    }
    if (active.length >= 2) {
      // NEW — a bare "cancel"/"no" with 2+ pendings must never guess which
      // one; asks explicitly and clears NOTHING until the user says which
      // (or "cancel both"/"cancel all", handled above).
      const taskId = providedTaskId || nanoid();
      const resultText = describeAmbiguousCancel(active);
      onEvent({ type: 'agent.completed', timestamp: Date.now(), taskId, data: { result: resultText, capability: 'orchestration' as any } });
      return {
        taskId, goal, status: 'success', outcome: 'blocked', result: resultText,
        steps: 0, tokensUsed: 0, actions: [], events: [],
        capability: { selected: 'orchestration', reason: 'Ambiguous cancellation — multiple pending actions active.', readAttempted: false, browserFallbackUsed: false },
      };
    }
    // zero active — fall through to normal routing, exactly as before this checkpoint.
  }
  // Any other new task text while something is pending is NOT authorization
  // to act — §9's "do not carry confirmation across unrelated turns" —
  // falls through to normal routing below. Pending actions stay intact
  // (not cleared) so a genuine confirmation can still arrive on a LATER
  // turn within its TTL; only an explicit reject or the TTL itself clears it.

  // Checkpoint 21 — a small, fixed set of compound-request shapes is tried
  // BEFORE any single-capability check: a compound sentence often contains
  // a clause that would, on its own, satisfy Calendar's or Gmail's own
  // classifier (e.g. "What do I have tomorrow, and remind me to..." embeds
  // a complete Calendar-list clause), so checking single-capability
  // detectors first would silently truncate the request to just that
  // clause. tryOrchestration() only ever matches its small fixed grammar —
  // anything else returns null immediately (cheap, no side effects) and
  // falls through to the unchanged single-capability/browser routing below.
  const orchestration = await tryOrchestration(goal, signal, sessionId);
  if (orchestration) {
    const taskId = providedTaskId || nanoid();
    return attemptOrchestration(goal, taskId, onEvent, signal, orchestration);
  }

  // Checkpoint 18/20 §7/§14 — Calendar and Tasks intent are both checked
  // before Gmail's and before subgoal decomposition, for the same reason
  // Gmail's own check runs early: all three are single-shot, not
  // multi-step browser chains, and have nothing to do with classifyGoal's
  // navigation types. Calendar is checked first only for historical
  // ordering stability (both detectors' trigger vocabularies are disjoint
  // by construction — see tasks/intent.ts's module comment — so this order
  // does not affect correctness, only which runs first when, in principle,
  // neither could ever both match the same text).
  const calendarIntent = detectCalendarIntent(goal);
  if (calendarIntent) {
    const taskId = providedTaskId || nanoid();
    return attemptCalendar(goal, taskId, onEvent, signal, sessionId);
  }

  const tasksIntent = detectTasksIntent(goal);
  if (tasksIntent) {
    const taskId = providedTaskId || nanoid();
    return attemptTasks(goal, taskId, onEvent, signal, sessionId);
  }

  // Checkpoint 17 §6 — Gmail intent is checked before subgoal decomposition
  // and before the read/browser CapabilityRouter: Gmail operations are
  // single-shot (not multi-step browser chains) and have nothing to do with
  // classifyGoal's browser-navigation goal types, so letting them reach
  // decomposeTask would misclassify them as multi-clause browser subgoals.
  const gmailIntent = detectGmailIntent(goal);
  if (gmailIntent) {
    const taskId = providedTaskId || nanoid();
    return attemptGmail(goal, taskId, onEvent, signal, sessionId);
  }

  // Post-CP23 fix — an unsupported-capability request ("call GV", "phone
  // Sarah") must fail fast and honestly, never reach the generic browser/
  // OmniRoute planner (which has no website to find for a phone call and
  // would spend real time trying). Checked AFTER Calendar/Tasks/Gmail so
  // their own content-bearing phrasings ("create a task to call GV
  // tomorrow") are already claimed by Tasks above and never reach this —
  // this only ever sees a BARE imperative "call/phone/ring X" with nothing
  // else recognized it first. Never touches Contacts — the response
  // doesn't need to know who "GV" resolves to, only that calling itself
  // isn't a capability JARVIS has (see unsupported-intent.ts).
  if (isUnsupportedPhoneCallIntent(goal)) {
    const taskId = providedTaskId || nanoid();
    const resultText = "I can't place phone calls yet.";
    onEvent({ type: 'agent.completed', timestamp: Date.now(), taskId, data: { result: resultText, capability: 'unsupported' as any } });
    return {
      taskId, goal, status: 'success', outcome: 'blocked', result: resultText,
      steps: 0, tokensUsed: 0, actions: [], events: [],
      capability: { selected: 'unsupported', reason: 'Recognized as a phone-call request — JARVIS has no phone-call capability.', readAttempted: false, browserFallbackUsed: false },
    };
  }

  // Checkpoint 14: only ever consider subgoal decomposition when the
  // existing single-goal classifier has nothing to offer for the WHOLE
  // task — anything classifyGoal already understands (navigate,
  // navigate_to_target, navigate_and_extract, search, search_and_open)
  // keeps running through the unmodified single-shot path below.
  const wholeTaskClassification = classifyGoal(goal);
  if (wholeTaskClassification.goalType === 'unclassified') {
    const decomposition = decomposeTask(goal);
    if (decomposition && 'rejected' in decomposition) {
      const taskId = providedTaskId || nanoid();
      console.log(`[subgoal] decomposition rejected: ${decomposition.rejected}`);
      return {
        taskId,
        goal,
        status: 'failed',
        outcome: 'failed',
        result: `Task not attempted: ${decomposition.rejected}`,
        steps: 0,
        tokensUsed: 0,
        actions: [],
        events: [],
      };
    }
    if (decomposition && 'subgoals' in decomposition) {
      const validation = validatePlan(decomposition.subgoals);
      if (validation.ok) {
        const plan: TaskPlan = { originalGoal: goal, subgoals: decomposition.subgoals, replans: 0 };
        console.log(
          `[subgoal] decomposed "${goal}" into ${plan.subgoals.length} subgoals: ${plan.subgoals.map((s) => `${s.id}:${s.type}`).join(', ')}`
        );
        return runTaskPlan(plan, onEvent, signal, providedTaskId);
      }
      console.log(`[subgoal] decomposition rejected by validator ("${validation.reason}") — falling back to single-shot`);
    }
  }

  const decision = routeCapability(goal);
  console.log(`[capability] selected=${decision.selectedCapability} reason="${decision.routingReason}"`);

  if (decision.selectedCapability === 'read') {
    const taskId = providedTaskId || nanoid();
    const { result: readResult, failure } = await attemptRead(goal, taskId, decision, onEvent, signal);

    if (readResult) {
      readResult.capability = {
        selected: 'read',
        reason: decision.routingReason,
        readAttempted: true,
        browserFallbackUsed: false,
      };
      return readResult;
    }

    // A cancelled read must end the task, not silently launch a browser.
    if (signal?.aborted) {
      return {
        taskId,
        goal,
        status: 'stopped',
        result: 'Task was cancelled by user',
        steps: 0,
        tokensUsed: 0,
        actions: [],
        events: [],
        capability: {
          selected: 'read',
          reason: decision.routingReason,
          readAttempted: true,
          readFailure: failure,
          browserFallbackUsed: false,
        },
      };
    }

    console.log(`[capability] read failed (${failure}) — falling back to browser`);
    const browserResult = await runBrowserTask({ goal, onEvent, signal, taskId, sessionId });
    browserResult.capability = {
      selected: 'browser',
      reason: decision.routingReason,
      fallbackCapability: 'browser',
      readAttempted: true,
      readFailure: failure,
      browserFallbackUsed: true,
    };
    return browserResult;
  }

  const result = await runBrowserTask({ goal, onEvent, signal, taskId: providedTaskId, sessionId });
  result.capability = {
    selected: 'browser',
    reason: decision.routingReason,
    readAttempted: false,
    browserFallbackUsed: false,
  };
  return result;
}

async function runBrowserTask(options: RunTaskOptions): Promise<ExecutionResult> {
  const { goal, onEvent, signal, taskId } = options;

  const browser = new BrowserController();
  const context = new ContextManager(goal);
  const skillRegistry = new SkillRegistry();
  const omniRoute = new OmniRouteClient();

  skillRegistry.register(new NavigationSkill(browser));
  skillRegistry.register(new ExtractionSkill(browser));
  skillRegistry.register(new InteractionSkill(browser));
  skillRegistry.register(new SearchSkill(browser));

  const planner = new Planner(omniRoute, skillRegistry, context);
  const executor = new AgentExecutor(browser, planner, context, skillRegistry, 10);

  const unsubscribe = executor.getEventCollector().subscribe(onEvent);

  try {
    return await executor.execute(goal, signal, taskId);
  } finally {
    unsubscribe();
  }
}
