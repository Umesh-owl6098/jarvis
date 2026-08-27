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
import { detectGmailIntent, isSendConfirmationPhrase, isUnambiguousSendPhrase, isSendCancelPhrase } from '@/core/capabilities/gmail/intent';
import { runGmailIntent } from '@/core/capabilities/gmail/runner';
import { getGmailClient, gmailAvailability } from '@/core/capabilities/gmail/resolve';
import { pendingActionStore } from '@/core/capabilities/gmail/pending-action';
import {
  detectCalendarIntent,
  unambiguousCalendarPhraseType,
  isAmbiguousCalendarConfirmPhrase,
  isCalendarRejectPhrase,
} from '@/core/capabilities/calendar/intent';
import { runCalendarIntent } from '@/core/capabilities/calendar/runner';
import { getCalendarClient, calendarAvailability } from '@/core/capabilities/calendar/resolve';
import { calendarPendingActionStore, type CalendarPendingActionType } from '@/core/capabilities/calendar/pending-action';
import { formatLocal } from '@/core/capabilities/calendar/datetime';

export interface RunTaskOptions {
  goal: string;
  onEvent: EventListener;
  signal?: AbortSignal;
  taskId?: string;
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
async function attemptGmailSendConfirmation(goal: string, taskId: string, onEvent: EventListener, signal?: AbortSignal): Promise<ExecutionResult> {
  onEvent({ type: 'task.started', timestamp: Date.now(), taskId, data: { task: goal, capability: 'gmail' } });

  const action = pendingActionStore.claim();
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
async function attemptCalendarConfirmation(goal: string, taskId: string, onEvent: EventListener, signal?: AbortSignal): Promise<ExecutionResult> {
  onEvent({ type: 'task.started', timestamp: Date.now(), taskId, data: { task: goal, capability: 'calendar' } });

  const action = calendarPendingActionStore.claim();
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
 * Checkpoint 18 §4-8 — the Calendar capability path. Every branch here is
 * read-only or proposal-only; createEvent/updateEvent/deleteEvent are never
 * reachable from this function (see attemptCalendarConfirmation above for
 * the ONLY mutation path).
 */
async function attemptCalendar(goal: string, taskId: string, onEvent: EventListener, signal?: AbortSignal): Promise<ExecutionResult> {
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

  const intent = detectCalendarIntent(goal)!; // caller already confirmed this is non-null
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
      const created = calendarPendingActionStore.set({ type, proposal: outcome.proposalCreated.proposal, createdAt: Date.now() });
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
async function attemptGmail(goal: string, taskId: string, onEvent: EventListener, signal?: AbortSignal): Promise<ExecutionResult> {
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
      const created = pendingActionStore.set({
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

export async function runTask(options: RunTaskOptions): Promise<ExecutionResult> {
  const { goal, onEvent, signal, taskId: providedTaskId } = options;
  console.log(`[integrity] runTask.task=${JSON.stringify(goal)} len=${goal.length}`);

  // Checkpoint 17/18 §9 — UNAMBIGUOUS phrases ("send it" / "create it",
  // "update it", "cancel it") are checked regardless of whether anything is
  // currently pending — their own vocabulary names the action, so a STALE
  // or REPEATED confirmation still gets an honest "nothing pending" answer
  // instead of silently falling through to unrelated browser routing.
  // Gmail's and Calendar's unambiguous vocabularies are disjoint by design
  // (send/send the email vs. create/update/cancel it) so these two checks
  // can never collide.
  const calendarPhraseType = unambiguousCalendarPhraseType(goal);
  if (calendarPhraseType) {
    const taskId = providedTaskId || nanoid();
    return attemptCalendarConfirmation(goal, taskId, onEvent, signal);
  }
  if (isUnambiguousSendPhrase(goal)) {
    const taskId = providedTaskId || nanoid();
    return attemptGmailSendConfirmation(goal, taskId, onEvent, signal);
  }

  // AMBIGUOUS bare words ("yes", "confirm", "go ahead") share vocabulary
  // across Gmail and Calendar by necessity — only ever treated as a
  // confirmation when EXACTLY ONE of the two pending stores is active; if
  // both happen to be active at once (rare — two different capabilities
  // mid-confirmation simultaneously), a bare word is genuinely ambiguous
  // and is NOT resolved here — §6/§9's "do not guess" applies to which
  // capability it refers to, not just to dates/times.
  const gmailPendingActive = !!pendingActionStore.active();
  const calendarPendingActive = !!calendarPendingActionStore.active();
  if (isAmbiguousCalendarConfirmPhrase(goal) || isSendConfirmationPhrase(goal)) {
    if (calendarPendingActive && !gmailPendingActive) {
      const taskId = providedTaskId || nanoid();
      return attemptCalendarConfirmation(goal, taskId, onEvent, signal);
    }
    if (gmailPendingActive && !calendarPendingActive) {
      const taskId = providedTaskId || nanoid();
      return attemptGmailSendConfirmation(goal, taskId, onEvent, signal);
    }
    // both or neither active — fall through; neither capability claims an
    // ambiguous bare word it can't uniquely resolve.
  }

  // Explicit rejection phrases similarly share some vocabulary ("no",
  // "stop", "never mind") — same exactly-one-active tiebreak.
  if (isCalendarRejectPhrase(goal) && calendarPendingActive && !gmailPendingActive) {
    calendarPendingActionStore.clear();
    const taskId = providedTaskId || nanoid();
    const resultText = 'Cancelled — the calendar change was not made.';
    onEvent({ type: 'agent.completed', timestamp: Date.now(), taskId, data: { result: resultText, capability: 'calendar' } });
    return {
      taskId, goal, status: 'success', outcome: 'completed', result: resultText,
      steps: 0, tokensUsed: 0, actions: [], events: [],
      capability: { selected: 'calendar', reason: 'Explicit cancellation of a pending Calendar action.', readAttempted: false, browserFallbackUsed: false },
    };
  }
  if (isSendCancelPhrase(goal) && gmailPendingActive && !calendarPendingActive) {
    pendingActionStore.clear();
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
  // Any other new task text while something is pending is NOT authorization
  // to act — §9's "do not carry confirmation across unrelated turns" —
  // falls through to normal routing below. Pending actions stay intact
  // (not cleared) so a genuine confirmation can still arrive on a LATER
  // turn within its TTL; only an explicit reject or the TTL itself clears it.

  // Checkpoint 18 §7 — Calendar intent is checked before Gmail's and before
  // subgoal decomposition, for the same reason Gmail's own check runs
  // early: Calendar operations are single-shot, not multi-step browser
  // chains, and have nothing to do with classifyGoal's navigation types.
  const calendarIntent = detectCalendarIntent(goal);
  if (calendarIntent) {
    const taskId = providedTaskId || nanoid();
    return attemptCalendar(goal, taskId, onEvent, signal);
  }

  // Checkpoint 17 §6 — Gmail intent is checked before subgoal decomposition
  // and before the read/browser CapabilityRouter: Gmail operations are
  // single-shot (not multi-step browser chains) and have nothing to do with
  // classifyGoal's browser-navigation goal types, so letting them reach
  // decomposeTask would misclassify them as multi-clause browser subgoals.
  const gmailIntent = detectGmailIntent(goal);
  if (gmailIntent) {
    const taskId = providedTaskId || nanoid();
    return attemptGmail(goal, taskId, onEvent, signal);
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
    const browserResult = await runBrowserTask({ goal, onEvent, signal, taskId });
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

  const result = await runBrowserTask({ goal, onEvent, signal, taskId: providedTaskId });
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
