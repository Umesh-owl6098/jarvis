/**
 * Checkpoint 24 — the pending-slot lifecycle: recording a missing-field
 * slot when a capability blocks on exactly one resolved-but-incomplete
 * question, and completing/cancelling it from the user's very next raw
 * turn. Split out of task-manager.ts so that file stays precedence/
 * orchestration only — everything Gmail/Calendar-specific about HOW a
 * slot gets created or resolved into a draft/proposal lives here instead.
 *
 * Depends only on pending-slot.ts (the store/types) and the same
 * capability modules (gmail/calendar/contacts/preferences) task-manager.ts
 * itself already depends on — nothing here imports task-manager.ts, so
 * there is no circular dependency. task-manager.ts calls exactly three
 * things from this file: recordGmailDraftBodySlot (from attemptGmail),
 * recordCalendarDatetimeSlot (from attemptCalendar), and
 * attemptPendingSlotCompletion (from runTaskCore's routing chain).
 *
 * Suspended-clarification semantics (documented, not incidental):
 *   - A slot represents ONE outstanding missing-field question, not
 *     general memory — see pending-slot.ts's own module comment. An
 *     unrelated command that interrupts (e.g. "What's on my calendar
 *     today?" while a Gmail slot is active) does NOT clear the slot; it is
 *     left active so a later turn can still answer the ORIGINAL question
 *     within its 10-minute TTL. This is intentional "suspended
 *     clarification," not a memory feature — the slot only ever answers
 *     the one question JARVIS just asked, nothing else.
 *   - A NEW missing-field question for the same capability (e.g. a second
 *     "email <person>") always REPLACES whatever slot was active — see
 *     recordGmailDraftBodySlot/recordCalendarDatetimeSlot below, both of
 *     which call pendingSlotStore.set(), which overwrites. This is what
 *     guarantees a stale recipient can never leak a later body.
 *   - At most one slot per session, always (pending-slot.ts's own
 *     invariant) — this file never creates more than one.
 */

import { nanoid } from 'nanoid';
import type { EventListener } from './events';
import type { ExecutionResult } from './executor';
import { pendingSlotStore, type GmailDraftBodySlot, type CalendarDatetimeSlot } from './pending-slot';

import { extractFollowUpEmailBody, isSendCancelPhrase, isGmailSpecificCancelPhrase } from '@/core/capabilities/gmail/intent';
import { getGmailClient, gmailAvailability } from '@/core/capabilities/gmail/resolve';
import { pendingActionStore } from '@/core/capabilities/gmail/pending-action';
import type { GmailOperationResult } from '@/core/capabilities/gmail/runner';

import { resolveDayPhrase, resolveClockTime, resolveDurationMinutes, isoAt, DEFAULT_TIMEZONE } from '@/core/capabilities/calendar/datetime';
import { runCalendarIntent, type CalendarOperationResult } from '@/core/capabilities/calendar/runner';
import { getCalendarClient, calendarAvailability } from '@/core/capabilities/calendar/resolve';
import { calendarPendingActionStore, type CalendarPendingActionType } from '@/core/capabilities/calendar/pending-action';
import { isCalendarRejectPhrase, isCalendarSpecificCancelPhrase, type CalendarIntent } from '@/core/capabilities/calendar/intent';

import { isTasksRejectPhrase, isTasksSpecificCancelPhrase } from '@/core/capabilities/tasks/intent';

import { resolvePerson } from '@/core/capabilities/contacts/resolver';
import { getContactsClient, contactsAvailability } from '@/core/capabilities/contacts/resolve';

import { isCancelAllPhrase } from '@/core/capabilities/shared/multi-pending';
import { preferencesStore } from '@/core/preferences/store';

/**
 * Checkpoint 24 — called from attemptGmail right after a draft outcome is
 * computed. The recipient is already resolved and the only thing missing
 * is the body ("email GV" shape) — records a typed gmail_draft_body slot
 * so the user's very next raw turn can supply the missing body without
 * repeating "draft"/"email"/"message". Never set for an ambiguous/
 * unresolved recipient — see awaitingBody's own comment in gmail/runner.ts,
 * which only ever populates it once a recipient is genuinely resolved.
 * A second call (a later "email <other person>") simply overwrites
 * whatever slot was active — see this file's module comment.
 */
export function recordGmailDraftBodySlot(sessionId: string, outcome: GmailOperationResult): void {
  if (!outcome.awaitingBody) return;
  pendingSlotStore.set(sessionId, {
    kind: 'gmail_draft_body',
    recipients: outcome.awaitingBody.recipients,
    cc: outcome.awaitingBody.cc,
    subject: outcome.awaitingBody.subject,
    createdAt: Date.now(),
  });
}

/**
 * Checkpoint 24 — called from attemptCalendar right after a propose_create
 * outcome is computed. A 'propose_create' blocked SPECIFICALLY on missing
 * date/time (never on any other clarification, e.g. an ambiguous update/
 * cancel search target) records a typed calendar_datetime slot, so the
 * user's very next raw turn ("Tomorrow at 2 PM") can complete the proposal
 * without repeating "schedule a meeting with X" again.
 *
 * Deliberately does NOT touch calendar/runner.ts's own attendee-resolution
 * order (needsClarification is checked there BEFORE attendee resolution —
 * see its module comment) — this attempts Contacts resolution
 * independently, exactly mirroring the same resolvePerson()/
 * contactsAvailability() pattern runner.ts itself uses, so a genuinely
 * ambiguous or unresolved name never creates an unsafe slot (matches
 * Gmail's identical "ambiguous contact -> no slot" rule).
 */
export async function recordCalendarDatetimeSlot(
  sessionId: string,
  intent: CalendarIntent,
  outcome: CalendarOperationResult,
  signal: AbortSignal | undefined
): Promise<void> {
  if (!(intent.operation === 'propose_create' && intent.needsClarification && outcome.status === 'blocked')) return;

  let slotAttendees = intent.attendees ?? [];
  let canCreateSlot = true;
  if (slotAttendees.length === 0 && intent.attendeeNameHint) {
    const contactsAvail = contactsAvailability();
    if (contactsAvail.available) {
      const personResolution = await resolvePerson(intent.attendeeNameHint, getContactsClient(), signal);
      if (personResolution.status === 'resolved') {
        slotAttendees = [personResolution.email];
      } else {
        canCreateSlot = false;
      }
    }
  }
  if (!canCreateSlot) return;

  pendingSlotStore.set(sessionId, {
    kind: 'calendar_datetime',
    attendees: slotAttendees,
    title: intent.title ?? 'Meeting',
    durationMinutes: intent.durationSource === 'explicit' ? intent.durationMinutes : undefined,
    createdAt: Date.now(),
  });
}

/**
 * Checkpoint 24 — completes a pending gmail_draft_body slot: the recipient
 * was already resolved on the PRIOR turn, so this only ever needs the
 * body. Mirrors attemptGmail's draft-success wrapping shape exactly. Never
 * reachable from a runner or from retrieved content — only
 * attemptPendingSlotCompletion below calls this, and only with the
 * literal raw user command.
 */
async function completeGmailDraftBodySlot(
  slot: GmailDraftBodySlot,
  rawGoal: string,
  providedTaskId: string | undefined,
  onEvent: EventListener,
  signal: AbortSignal | undefined,
  sessionId: string
): Promise<ExecutionResult> {
  const taskId = providedTaskId || nanoid();
  onEvent({ type: 'task.started', timestamp: Date.now(), taskId, data: { task: rawGoal, capability: 'gmail' } });

  const availability = gmailAvailability();
  if (!availability.available) {
    const resultText = availability.reason;
    onEvent({ type: 'agent.failed', timestamp: Date.now(), taskId, data: { reason: resultText } });
    return {
      taskId, goal: rawGoal, status: 'failed', outcome: 'failed', result: resultText,
      steps: 0, tokensUsed: 0, actions: [], events: [], error: resultText,
      capability: { selected: 'gmail', reason: 'Gmail capability matched but is not yet authorized.', readAttempted: false, browserFallbackUsed: false },
    };
  }
  if (signal?.aborted) {
    const resultText = 'Cancelled by user.';
    onEvent({ type: 'task.stopped', timestamp: Date.now(), taskId, data: { reason: 'user_cancelled' } });
    return {
      taskId, goal: rawGoal, status: 'stopped', result: resultText,
      steps: 0, tokensUsed: 0, actions: [], events: [],
      capability: { selected: 'gmail', reason: 'Cancelled before the Gmail operation started.', readAttempted: false, browserFallbackUsed: false },
    };
  }

  const body = extractFollowUpEmailBody(rawGoal);
  const subject = slot.subject || '(no subject)';
  try {
    const client = getGmailClient();
    const draft = await client.createDraft(slot.recipients, subject, body, slot.cc, signal);
    pendingSlotStore.clear(sessionId);
    const created = pendingActionStore.set(sessionId, {
      type: 'gmail_send', draftId: draft.draftId, recipient: slot.recipients, subject, createdAt: Date.now(),
    });
    const ccLine = slot.cc?.length ? `\nCC: ${slot.cc.join(', ')}` : '';
    const resultText = `DRAFT CREATED\n\nTo: ${slot.recipients.join(', ')}${ccLine}\nSubject: ${subject}\nBody: ${body || '(empty)'}`;
    onEvent({ type: 'agent.completed', timestamp: Date.now(), taskId, data: { result: resultText, capability: 'gmail' } });
    return {
      taskId, goal: rawGoal, status: 'success', outcome: 'completed', result: resultText,
      steps: 0, tokensUsed: 0, actions: ['gmail:draft'], events: [],
      capability: { selected: 'gmail', reason: 'Completed a pending missing-body question from the prior turn.', readAttempted: false, browserFallbackUsed: false },
      gmail: { operation: 'draft', pendingAction: { type: 'gmail_send', recipient: created.recipient, subject: created.subject, confirmationRequired: true } },
    };
  } catch (e: any) {
    const aborted = e?.name === 'AbortError' || signal?.aborted;
    const resultText = aborted ? 'Cancelled by user.' : `Gmail operation failed: ${e?.message ?? 'unknown error'}`;
    onEvent(aborted
      ? { type: 'task.stopped', timestamp: Date.now(), taskId, data: { reason: 'user_cancelled' } }
      : { type: 'agent.failed', timestamp: Date.now(), taskId, data: { reason: resultText } });
    return {
      taskId, goal: rawGoal, status: aborted ? 'stopped' : 'failed', outcome: aborted ? undefined : 'failed', result: resultText,
      steps: 0, tokensUsed: 0, actions: [], events: [], error: aborted ? undefined : resultText,
      capability: { selected: 'gmail', reason: aborted ? 'Cancelled during the Gmail operation.' : 'Gmail operation threw.', readAttempted: false, browserFallbackUsed: false },
    };
  }
}

/**
 * Checkpoint 24 — completes a pending calendar_datetime slot: the
 * attendee(s)/title were already resolved on the PRIOR turn, so this only
 * ever needs a date/time (and, optionally, an overriding duration). Builds
 * a CalendarIntent directly (rather than re-parsing a reconstructed
 * sentence through detectCalendarIntent, which would risk re-deriving a
 * garbled title/attendee from text never meant to stand alone) and routes
 * it through the SAME runCalendarIntent() the one-shot create path uses —
 * so Contacts resolution is never repeated, and duration/timezone/
 * conflict-detection/confirmation-gating behavior is identical to a
 * fully-specified one-shot command.
 */
async function completeCalendarDatetimeSlot(
  slot: CalendarDatetimeSlot,
  rawGoal: string,
  providedTaskId: string | undefined,
  onEvent: EventListener,
  signal: AbortSignal | undefined,
  sessionId: string
): Promise<ExecutionResult> {
  const taskId = providedTaskId || nanoid();
  onEvent({ type: 'task.started', timestamp: Date.now(), taskId, data: { task: rawGoal, capability: 'calendar' } });

  const availability = calendarAvailability();
  if (!availability.available) {
    const resultText = availability.reason;
    onEvent({ type: 'agent.failed', timestamp: Date.now(), taskId, data: { reason: resultText } });
    return {
      taskId, goal: rawGoal, status: 'failed', outcome: 'failed', result: resultText,
      steps: 0, tokensUsed: 0, actions: [], events: [], error: resultText,
      capability: { selected: 'calendar', reason: 'Calendar capability matched but is not yet authorized.', readAttempted: false, browserFallbackUsed: false },
    };
  }
  if (signal?.aborted) {
    const resultText = 'Cancelled by user.';
    onEvent({ type: 'task.stopped', timestamp: Date.now(), taskId, data: { reason: 'user_cancelled' } });
    return {
      taskId, goal: rawGoal, status: 'stopped', result: resultText,
      steps: 0, tokensUsed: 0, actions: [], events: [],
      capability: { selected: 'calendar', reason: 'Cancelled before the Calendar operation started.', readAttempted: false, browserFallbackUsed: false },
    };
  }

  // Never guesses: if this follow-up STILL doesn't resolve a date/time, the
  // slot stays active (not cleared) and the SAME clarification is re-asked
  // — the user gets another chance within the TTL rather than the answer
  // silently falling through to browser/OmniRoute.
  const day = resolveDayPhrase(rawGoal);
  const clock = resolveClockTime(rawGoal);
  if (!day || !clock) {
    const resultText = !day
      ? 'No date was found in the request (e.g. "tomorrow", "Friday", "next Monday").'
      : 'No specific time was found in the request — only a date. Please specify a time (e.g. "at 3 PM") or a part of day (e.g. "afternoon").';
    onEvent({ type: 'agent.completed', timestamp: Date.now(), taskId, data: { result: resultText, capability: 'calendar' } });
    return {
      taskId, goal: rawGoal, status: 'success', outcome: 'blocked', result: resultText,
      steps: 0, tokensUsed: 0, actions: [], events: [],
      capability: { selected: 'calendar', reason: 'Follow-up still did not resolve a date/time — re-asking, nothing scheduled.', readAttempted: false, browserFallbackUsed: false },
    };
  }

  // Answer is usable — consume the slot now regardless of what happens
  // next (a second follow-up must never reuse an already-answered slot).
  pendingSlotStore.clear(sessionId);

  const explicitDuration = resolveDurationMinutes(rawGoal);
  const preferredDuration = preferencesStore.get('meetingDurationMinutes');
  const duration = explicitDuration ?? slot.durationMinutes ?? preferredDuration ?? 30;
  const durationSource: 'explicit' | 'preference' | 'default' =
    explicitDuration !== null || slot.durationMinutes !== undefined ? 'explicit' : preferredDuration !== undefined ? 'preference' : 'default';
  const start = isoAt(day.daysFromNow, clock.hour, clock.minute);
  const end = new Date(new Date(start).getTime() + duration * 60000).toISOString();

  const intent: CalendarIntent = {
    operation: 'propose_create',
    raw: rawGoal,
    timezone: DEFAULT_TIMEZONE,
    title: slot.title,
    attendees: slot.attendees,
    proposedStart: start,
    proposedEnd: end,
    durationMinutes: duration,
    durationSource,
  };

  try {
    const client = getCalendarClient();
    const outcome = await runCalendarIntent(intent, client, signal);

    if (outcome.status === 'stopped') {
      onEvent({ type: 'task.stopped', timestamp: Date.now(), taskId, data: { reason: 'user_cancelled' } });
      return {
        taskId, goal: rawGoal, status: 'stopped', result: outcome.resultText,
        steps: 0, tokensUsed: 0, actions: ['calendar:propose_create'], events: [],
        capability: { selected: 'calendar', reason: 'Cancelled during the Calendar operation.', readAttempted: false, browserFallbackUsed: false },
        calendar: { operation: 'propose_create' },
      };
    }

    let pendingAction: { type: CalendarPendingActionType; title: string; start: string; confirmationRequired: true } | undefined;
    if (outcome.proposalCreated) {
      const created = calendarPendingActionStore.set(sessionId, { type: 'calendar_create', proposal: outcome.proposalCreated.proposal, createdAt: Date.now() });
      pendingAction = { type: 'calendar_create', title: created.proposal.title, start: created.proposal.start, confirmationRequired: true };
    }

    const eventType = outcome.status === 'completed' ? 'agent.completed' : 'agent.failed';
    onEvent({ type: eventType, timestamp: Date.now(), taskId, data: { result: outcome.resultText, capability: 'calendar' } });

    return {
      taskId,
      goal: rawGoal,
      status: outcome.status === 'completed' ? 'success' : 'failed',
      outcome: outcome.status === 'completed' ? 'completed' : outcome.status === 'blocked' ? 'blocked' : 'failed',
      result: outcome.resultText,
      steps: 0,
      tokensUsed: 0,
      actions: ['calendar:propose_create'],
      events: [],
      capability: { selected: 'calendar', reason: 'Completed a pending missing-date/time question from the prior turn.', readAttempted: false, browserFallbackUsed: false },
      calendar: { operation: 'propose_create', pendingAction },
    };
  } catch (e: any) {
    const aborted = e?.name === 'AbortError' || signal?.aborted;
    const resultText = aborted ? 'Cancelled by user.' : `Calendar operation failed: ${e?.message ?? 'unknown error'}`;
    onEvent(aborted
      ? { type: 'task.stopped', timestamp: Date.now(), taskId, data: { reason: 'user_cancelled' } }
      : { type: 'agent.failed', timestamp: Date.now(), taskId, data: { reason: resultText } });
    return {
      taskId, goal: rawGoal, status: aborted ? 'stopped' : 'failed', outcome: aborted ? undefined : 'failed', result: resultText,
      steps: 0, tokensUsed: 0, actions: [], events: [], error: aborted ? undefined : resultText,
      capability: { selected: 'calendar', reason: aborted ? 'Cancelled during the Calendar operation.' : 'Calendar operation threw.', readAttempted: false, browserFallbackUsed: false },
    };
  }
}

/**
 * Checkpoint 24 — the single entry point for completing an outstanding
 * gmail_draft_body/calendar_datetime slot from the user's very next RAW
 * turn. Only ever called from task-manager.ts's runTaskCore, and only
 * AFTER every explicit-command detector above it (orchestration, Calendar,
 * Tasks, Gmail, the unsupported-call guard) already had a chance to claim
 * the text and returned nothing — this ordering is exactly what keeps an
 * active slot from ever hijacking a genuinely new, complete command:
 * "What's on my calendar today?" or "create a task to call GV tomorrow"
 * are both recognized, complete commands for OTHER capabilities and are
 * dispatched by their own detectors long before this function is ever
 * reached, leaving whatever slot was active untouched (not cleared, not
 * consumed) for the user to still answer later within its TTL — see this
 * file's module comment on "suspended clarification."
 *
 * A pending slot is NOT authorization: this function only ever builds the
 * same draft/proposal the underlying capability already builds for a
 * fully-specified one-shot command — it never itself sends an email or
 * creates/updates/deletes a Calendar event; those still require the
 * capability's own separate, unmodified confirmation gate.
 *
 * Prompt-injection boundary: `rawGoal` is always the literal top-level
 * user command (this is only ever invoked from runTaskCore on
 * options.goal) — retrieved Gmail/Calendar/Contacts/Tasks/browser content
 * never reaches this function and can never fill or clear a slot.
 */
export async function attemptPendingSlotCompletion(
  rawGoal: string,
  providedTaskId: string | undefined,
  onEvent: EventListener,
  signal: AbortSignal | undefined,
  sessionId: string
): Promise<ExecutionResult | null> {
  const slot = pendingSlotStore.active(sessionId);
  if (!slot) return null;

  // A cancel-shaped reply must never be mistaken for a body/datetime
  // answer (e.g. drafting an email whose body is literally "Cancel it.").
  // "Start over" is already handled earlier in runTask() itself and never
  // reaches this function.
  const isCancelish =
    isCalendarRejectPhrase(rawGoal) ||
    isTasksRejectPhrase(rawGoal) ||
    isSendCancelPhrase(rawGoal) ||
    isGmailSpecificCancelPhrase(rawGoal) ||
    isCalendarSpecificCancelPhrase(rawGoal) ||
    isTasksSpecificCancelPhrase(rawGoal) ||
    isCancelAllPhrase(rawGoal);
  if (isCancelish) {
    pendingSlotStore.clear(sessionId);
    const taskId = providedTaskId || nanoid();
    const resultText = slot.kind === 'gmail_draft_body' ? 'Cancelled — no draft was created.' : 'Cancelled — no event was scheduled.';
    const capability = slot.kind === 'gmail_draft_body' ? ('gmail' as const) : ('calendar' as const);
    onEvent({ type: 'agent.completed', timestamp: Date.now(), taskId, data: { result: resultText, capability } });
    return {
      taskId, goal: rawGoal, status: 'success', outcome: 'completed', result: resultText,
      steps: 0, tokensUsed: 0, actions: [], events: [],
      capability: { selected: capability, reason: 'Explicit cancellation of a pending missing-field question.', readAttempted: false, browserFallbackUsed: false },
    };
  }

  if (slot.kind === 'gmail_draft_body') {
    return completeGmailDraftBodySlot(slot, rawGoal, providedTaskId, onEvent, signal, sessionId);
  }
  return completeCalendarDatetimeSlot(slot, rawGoal, providedTaskId, onEvent, signal, sessionId);
}
