/**
 * Checkpoint 21 — a thin orchestration layer above the existing Gmail/
 * Calendar/Tasks capabilities, NOT a second router. It recognizes a small,
 * deliberately fixed set of two-step compound request SHAPES (matched by
 * plain regex on the raw goal text, exactly once, before any capability is
 * touched — never re-parsed from retrieved content) and executes each step
 * through the SAME functions the single-capability path already uses:
 * detectCalendarIntent/detectGmailIntent/detectTasksIntent for parsing,
 * runCalendarIntent/runGmailIntent/runTasksIntent for execution, and the
 * SAME PendingAction stores for any mutation. This is why no new
 * confirmation mechanism is needed: a proposal an orchestration step
 * creates is indistinguishable, from the confirmation gate's point of
 * view, from one a single-capability request would have created — "Create
 * it."/"Send it."/"Mark it complete." already work unchanged.
 *
 * No LLM anywhere in this file. Decomposition is a fixed pattern match;
 * "understanding" a dependent step (which meeting is "last", what a found
 * email's sender is) is plain data lookup on already-fetched, normalized
 * capability data (CalendarEvent/MailMessage), never a fresh reasoning
 * call. A step that mutates state still only ever produces a *proposal*
 * (proposalCreated) — creating/sending/completing/deleting is reached
 * exclusively through the pre-existing confirmation-claim functions in
 * task-manager.ts, unchanged by this file.
 *
 * Supported patterns (deliberately small — see PATTERNS.md-equivalent
 * comments on each function below; anything else falls through to normal
 * single-capability / browser routing, same as before this checkpoint):
 *   1. Calendar read -> Tasks proposal, with a "after my last/first
 *      meeting" dependency ("What do I have tomorrow, and remind me to
 *      call GV after my last meeting?").
 *   2. Gmail search -> Tasks proposal referencing the found email ("Find
 *      the latest email from John and create a task to reply tomorrow.").
 *   3. Calendar proposal (with Contacts-resolved attendee) -> Gmail draft
 *      to the SAME resolved person via pronoun substitution ("Schedule a
 *      meeting with GV next week and draft an email telling them.").
 *   4. Calendar read + Tasks read, no dependency, combined into one
 *      summary ("Show my tasks and calendar for Friday and tell me what's
 *      still open.").
 */

import { detectCalendarIntent } from '@/core/capabilities/calendar/intent';
import { runCalendarIntent } from '@/core/capabilities/calendar/runner';
import { getCalendarClient, calendarAvailability } from '@/core/capabilities/calendar/resolve';
import { calendarPendingActionStore } from '@/core/capabilities/calendar/pending-action';
import { resolveDayPhrase, dayRangeIso, formatLocal, DEFAULT_TIMEZONE } from '@/core/capabilities/calendar/datetime';

import { detectGmailIntent } from '@/core/capabilities/gmail/intent';
import { runGmailIntent } from '@/core/capabilities/gmail/runner';
import { getGmailClient, gmailAvailability } from '@/core/capabilities/gmail/resolve';
import { pendingActionStore } from '@/core/capabilities/gmail/pending-action';

import { getTasksClient, tasksAvailability } from '@/core/capabilities/tasks/resolve';
import { tasksPendingActionStore } from '@/core/capabilities/tasks/pending-action';
import { taskDueIso, formatDueDate } from '@/core/capabilities/tasks/datetime';
import type { TaskProposal } from '@/core/capabilities/tasks/types';

import { detectCompoundQuery, type CapabilityConcept } from '@/core/capabilities/shared/compound-classifier';

export type OrchestrationStepStatus = 'completed' | 'pending_confirmation' | 'failed' | 'skipped_dependency';

export interface OrchestrationStepResult {
  id: string;
  capability: 'calendar' | 'gmail' | 'tasks';
  description: string;
  status: OrchestrationStepStatus;
  resultText: string;
  /**
   * Checkpoint 21 fix — true ONLY when this step performed a real,
   * externally-visible backend WRITE that is not itself gated behind a
   * confirmation (Gmail draft creation is the one case among the 4
   * patterns: draft creation has never been confirmation-gated, per
   * Checkpoint 17's own established semantics — only SEND is). Calendar's
   * and Tasks' propose_* operations never call createEvent/createTask, so
   * this is always false for them; they're pure in-memory PendingAction
   * proposals until separately confirmed. Reporting code must check this
   * explicitly rather than inferring "no mutation" from `status !==
   * 'completed'` — a 'pending_confirmation' Gmail-draft step still
   * performed a real write.
   */
  remoteWriteOccurred?: boolean;
}

export interface OrchestrationResult {
  /** Which fixed pattern matched — for observability only. */
  pattern: string;
  status: 'completed' | 'partial' | 'blocked' | 'failed';
  steps: OrchestrationStepResult[];
  summaryText: string;
}

function isAbortError(e: any): boolean {
  return e?.name === 'AbortError' || e?.code === 'ABORTED' || /aborted|cancelled/i.test(e?.message ?? '');
}

/** Worst-status-wins: failed > blocked (an ambiguity/skip with no hard error) > partial (something still needs confirmation) > completed. */
function overallStatus(steps: OrchestrationStepResult[]): OrchestrationResult['status'] {
  if (steps.some((s) => s.status === 'failed')) return 'failed';
  if (steps.some((s) => s.status === 'skipped_dependency')) return 'blocked';
  if (steps.some((s) => s.status === 'pending_confirmation')) return 'partial';
  return 'completed';
}

function summarize(steps: OrchestrationStepResult[]): string {
  return steps.map((s) => `[${s.status.toUpperCase()}] ${s.description}\n${s.resultText}`).join('\n\n');
}

// ============================================================
// Pattern 1 — Calendar read -> Tasks proposal, "after my last/first meeting"
// ============================================================

const AFTER_MEETING_RE = /^(.+?)\s+and\s+remind me to\s+(.+?)\s+after\s+(?:my\s+)?(last|first)\s+meeting\b.*$/i;

async function tryCalendarThenTaskAfterMeeting(t: string, signal: AbortSignal | undefined, sessionId: string): Promise<OrchestrationResult | null> {
  const m = AFTER_MEETING_RE.exec(t);
  if (!m) return null;

  const calendarClause = m[1].replace(/[,.]+$/, '').trim();
  const taskAction = m[2].trim();
  const which = m[3].toLowerCase() as 'last' | 'first';

  const calIntent = detectCalendarIntent(calendarClause);
  if (!calIntent || calIntent.operation !== 'list') return null; // not this pattern after all — let normal routing handle it

  const steps: OrchestrationStepResult[] = [];

  const calAvail = calendarAvailability();
  if (!calAvail.available) {
    steps.push({ id: 'read-calendar', capability: 'calendar', description: 'Read calendar', status: 'failed', resultText: calAvail.reason });
    steps.push({ id: 'create-task', capability: 'tasks', description: 'Prepare reminder task', status: 'skipped_dependency', resultText: 'Skipped — the calendar read this depends on could not run.' });
    return { pattern: 'calendar-then-task-after-meeting', status: 'failed', steps, summaryText: summarize(steps) };
  }

  const calClient = getCalendarClient();
  let events;
  try {
    events = await calClient.listEvents(calIntent.rangeStart!, calIntent.rangeEnd!, calIntent.timezone, 50, signal);
  } catch (e: any) {
    if (isAbortError(e) || signal?.aborted) throw e; // let the caller report a clean 'stopped', not a fabricated step
    steps.push({ id: 'read-calendar', capability: 'calendar', description: 'Read calendar', status: 'failed', resultText: `Calendar read failed: ${e?.message ?? 'unknown error'}` });
    steps.push({ id: 'create-task', capability: 'tasks', description: 'Prepare reminder task', status: 'skipped_dependency', resultText: 'Skipped — the calendar read this depends on failed.' });
    return { pattern: 'calendar-then-task-after-meeting', status: 'failed', steps, summaryText: summarize(steps) };
  }

  steps.push({
    id: 'read-calendar',
    capability: 'calendar',
    description: 'Read calendar',
    status: 'completed',
    resultText: events.length ? events.map((e) => `• ${e.title} — ${formatLocal(e.start, calIntent.timezone)}`).join('\n') : 'No events found in that range.',
  });

  if (events.length === 0) {
    steps.push({
      id: 'create-task',
      capability: 'tasks',
      description: 'Prepare reminder task',
      status: 'skipped_dependency',
      resultText: `Skipped — no meetings were found for that day, so "after my ${which} meeting" can't be resolved. Never guessed a time.`,
    });
    return { pattern: 'calendar-then-task-after-meeting', status: 'blocked', steps, summaryText: summarize(steps) };
  }

  const sorted = [...events].sort((a, b) => (a.start < b.start ? -1 : 1));
  const targetEvent = which === 'last' ? sorted[sorted.length - 1] : sorted[0];

  const tasksAvail = tasksAvailability();
  if (!tasksAvail.available) {
    steps.push({ id: 'create-task', capability: 'tasks', description: 'Prepare reminder task', status: 'failed', resultText: tasksAvail.reason });
    return { pattern: 'calendar-then-task-after-meeting', status: 'failed', steps, summaryText: summarize(steps) };
  }

  const tasksClient = getTasksClient();
  const dayPhrase = resolveDayPhrase(calendarClause) ?? { daysFromNow: 0, label: 'today' };
  const due = taskDueIso(dayPhrase.daysFromNow);
  const title = taskAction.charAt(0).toUpperCase() + taskAction.slice(1).replace(/[.,!?]+$/, '');
  // §29-style honesty, carried into orchestration: Tasks' `due` is DATE-ONLY
  // (see tasks/types.ts) — "after my last meeting" can never become an
  // actual trigger time, only descriptive context in the notes.
  const notes = `Context: after your ${which} meeting that day — "${targetEvent.title}" (${formatLocal(targetEvent.start, calIntent.timezone)}–${formatLocal(targetEvent.end, calIntent.timezone)}). Google Tasks only supports a due DATE, not a specific time, so this will NOT trigger automatically right after that meeting ends.`;

  const proposal: TaskProposal = { kind: 'create', title, notes, due, taskListId: tasksClient.defaultListId };
  tasksPendingActionStore.set(sessionId, { type: 'tasks_create', proposal, createdAt: Date.now() });

  steps.push({
    id: 'create-task',
    capability: 'tasks',
    description: 'Prepare reminder task',
    status: 'pending_confirmation',
    resultText: `TASK READY FOR CONFIRMATION\n\nTASK: ${title}\nDUE DATE: ${formatDueDate(due)}\n${notes}`,
  });

  return { pattern: 'calendar-then-task-after-meeting', status: overallStatus(steps), steps, summaryText: summarize(steps) };
}

// ============================================================
// Pattern 2 — Gmail search -> Tasks proposal referencing the found email
// ============================================================

const REPLY_TASK_RE = /^(.+?)\s+and\s+create a task to\s+(.+)$/i;

async function tryGmailThenTaskReply(t: string, signal: AbortSignal | undefined, sessionId: string): Promise<OrchestrationResult | null> {
  const m = REPLY_TASK_RE.exec(t);
  if (!m) return null;

  const gmailClause = m[1].trim();
  const taskAction = m[2].trim();

  const gmailIntent = detectGmailIntent(gmailClause);
  if (!gmailIntent || (gmailIntent.operation !== 'search' && gmailIntent.operation !== 'list')) return null;

  const steps: OrchestrationStepResult[] = [];

  const gAvail = gmailAvailability();
  if (!gAvail.available) {
    steps.push({ id: 'search-email', capability: 'gmail', description: 'Search email', status: 'failed', resultText: gAvail.reason });
    steps.push({ id: 'create-task', capability: 'tasks', description: 'Prepare reply task', status: 'skipped_dependency', resultText: 'Skipped — the email search this depends on could not run.' });
    return { pattern: 'gmail-then-task-reply', status: 'failed', steps, summaryText: summarize(steps) };
  }

  const gmailClient = getGmailClient();
  let outcome;
  try {
    outcome = await runGmailIntent(gmailIntent, gmailClient, signal);
  } catch (e: any) {
    if (isAbortError(e) || signal?.aborted) throw e;
    steps.push({ id: 'search-email', capability: 'gmail', description: 'Search email', status: 'failed', resultText: `Gmail search failed: ${e?.message ?? 'unknown error'}` });
    steps.push({ id: 'create-task', capability: 'tasks', description: 'Prepare reply task', status: 'skipped_dependency', resultText: 'Skipped — the email search this depends on failed.' });
    return { pattern: 'gmail-then-task-reply', status: 'failed', steps, summaryText: summarize(steps) };
  }

  steps.push({ id: 'search-email', capability: 'gmail', description: 'Search email', status: 'completed', resultText: outcome.resultText });

  const q = gmailIntent.searchQuery ?? '';
  const searchResult = await gmailClient.search(q, 5, signal);
  if (searchResult.messages.length === 0) {
    steps.push({
      id: 'create-task',
      capability: 'tasks',
      description: 'Prepare reply task',
      status: 'skipped_dependency',
      resultText: `Skipped — no matching email was found for "${q}", so there's nothing concrete for the reply task to reference. Never guessed.`,
    });
    return { pattern: 'gmail-then-task-reply', status: 'blocked', steps, summaryText: summarize(steps) };
  }
  const top = searchResult.messages[0];

  const tasksAvail = tasksAvailability();
  if (!tasksAvail.available) {
    steps.push({ id: 'create-task', capability: 'tasks', description: 'Prepare reply task', status: 'failed', resultText: tasksAvail.reason });
    return { pattern: 'gmail-then-task-reply', status: 'failed', steps, summaryText: summarize(steps) };
  }

  const tasksClient = getTasksClient();
  const dayPhrase = resolveDayPhrase(taskAction) ?? { daysFromNow: 1, label: 'tomorrow' };
  const due = taskDueIso(dayPhrase.daysFromNow);
  const title = `Reply to ${top.from}`;
  const notes = `Re: "${top.subject}" (${top.date})`;

  const proposal: TaskProposal = { kind: 'create', title, notes, due, taskListId: tasksClient.defaultListId };
  tasksPendingActionStore.set(sessionId, { type: 'tasks_create', proposal, createdAt: Date.now() });

  steps.push({
    id: 'create-task',
    capability: 'tasks',
    description: 'Prepare reply task',
    status: 'pending_confirmation',
    resultText: `TASK READY FOR CONFIRMATION\n\nTASK: ${title}\nDUE DATE: ${formatDueDate(due)}\n${notes}`,
  });

  return { pattern: 'gmail-then-task-reply', status: overallStatus(steps), steps, summaryText: summarize(steps) };
}

// ============================================================
// Pattern 3 — Calendar proposal (Contacts-resolved attendee) -> Gmail draft to the SAME person
// ============================================================

const CAL_THEN_EMAIL_RE = /^(.+?)\s+and\s+draft an email\s+(?:telling|to)\s+(?:them|him|her)\b(.*)$/i;

async function tryCalendarThenGmailPronoun(t: string, signal: AbortSignal | undefined, sessionId: string): Promise<OrchestrationResult | null> {
  const m = CAL_THEN_EMAIL_RE.exec(t);
  if (!m) return null;

  const calClause = m[1].trim();
  const tail = (m[2] ?? '').replace(/^[\s,]+/, '').replace(/[.,!?]+$/, '').trim();

  const calIntent = detectCalendarIntent(calClause);
  if (!calIntent || calIntent.operation !== 'propose_create') return null;

  const steps: OrchestrationStepResult[] = [];

  const calAvail = calendarAvailability();
  if (!calAvail.available) {
    steps.push({ id: 'propose-event', capability: 'calendar', description: 'Prepare calendar proposal', status: 'failed', resultText: calAvail.reason });
    steps.push({ id: 'draft-email', capability: 'gmail', description: 'Draft email', status: 'skipped_dependency', resultText: 'Skipped — the calendar step this depends on could not run.' });
    return { pattern: 'calendar-then-gmail-pronoun', status: 'failed', steps, summaryText: summarize(steps) };
  }

  const calClient = getCalendarClient();
  let calOutcome;
  try {
    calOutcome = await runCalendarIntent(calIntent, calClient, signal);
  } catch (e: any) {
    if (isAbortError(e) || signal?.aborted) throw e;
    steps.push({ id: 'propose-event', capability: 'calendar', description: 'Prepare calendar proposal', status: 'failed', resultText: `Calendar operation failed: ${e?.message ?? 'unknown error'}` });
    steps.push({ id: 'draft-email', capability: 'gmail', description: 'Draft email', status: 'skipped_dependency', resultText: 'Skipped — the calendar step this depends on failed.' });
    return { pattern: 'calendar-then-gmail-pronoun', status: 'failed', steps, summaryText: summarize(steps) };
  }

  // §5's "ambiguous contact blocks dependent actions" — Contacts resolution
  // already happened INSIDE runCalendarIntent (attendeeNameHint ->
  // resolvePerson). If it didn't resolve to exactly one proposal, the
  // Gmail step — which refers to the SAME "them" — must be skipped, never
  // independently re-resolved (that would silently ignore the ambiguity).
  if (calOutcome.status !== 'completed' || !calOutcome.proposalCreated) {
    steps.push({ id: 'propose-event', capability: 'calendar', description: 'Prepare calendar proposal', status: 'failed', resultText: calOutcome.resultText });
    steps.push({
      id: 'draft-email',
      capability: 'gmail',
      description: 'Draft email',
      status: 'skipped_dependency',
      resultText: 'Skipped — "them" refers to the contact from the calendar step, which did not resolve cleanly. Never guessed who to email.',
    });
    return { pattern: 'calendar-then-gmail-pronoun', status: 'blocked', steps, summaryText: summarize(steps) };
  }

  calendarPendingActionStore.set(sessionId, { type: 'calendar_create', proposal: calOutcome.proposalCreated.proposal, createdAt: Date.now() });
  steps.push({ id: 'propose-event', capability: 'calendar', description: 'Prepare calendar proposal', status: 'pending_confirmation', resultText: calOutcome.resultText });

  const attendeeEmail = calOutcome.proposalCreated.proposal.attendees[0];
  if (!attendeeEmail) {
    steps.push({
      id: 'draft-email',
      capability: 'gmail',
      description: 'Draft email',
      status: 'skipped_dependency',
      resultText: 'Skipped — no attendee was resolved for the calendar step, so there\'s no one "them" refers to.',
    });
    return { pattern: 'calendar-then-gmail-pronoun', status: overallStatus(steps), steps, summaryText: summarize(steps) };
  }

  const gAvail = gmailAvailability();
  if (!gAvail.available) {
    steps.push({ id: 'draft-email', capability: 'gmail', description: 'Draft email', status: 'failed', resultText: gAvail.reason });
    return { pattern: 'calendar-then-gmail-pronoun', status: 'failed', steps, summaryText: summarize(steps) };
  }

  const gmailClient = getGmailClient();
  const proposal = calOutcome.proposalCreated.proposal;
  const body = tail || `Just scheduled: ${proposal.title} — ${formatLocal(proposal.start, proposal.timezone)} to ${formatLocal(proposal.end, proposal.timezone)}.`;
  let draft;
  try {
    draft = await gmailClient.createDraft([attendeeEmail], '(no subject)', body, undefined, signal);
  } catch (e: any) {
    if (isAbortError(e) || signal?.aborted) throw e;
    steps.push({ id: 'draft-email', capability: 'gmail', description: 'Draft email', status: 'failed', resultText: `Draft creation failed: ${e?.message ?? 'unknown error'}` });
    return { pattern: 'calendar-then-gmail-pronoun', status: 'failed', steps, summaryText: summarize(steps) };
  }
  pendingActionStore.set(sessionId, { type: 'gmail_send', draftId: draft.draftId, recipient: [attendeeEmail], subject: draft.subject, createdAt: Date.now() });

  steps.push({
    id: 'draft-email',
    capability: 'gmail',
    description: 'Draft email',
    status: 'pending_confirmation',
    // A real Gmail draft object now exists — draft creation was never
    // confirmation-gated (Checkpoint 17), only SEND is. Reporting code
    // must not read "pending_confirmation" as "nothing real happened yet."
    remoteWriteOccurred: true,
    resultText: `DRAFT CREATED\n\nTo: ${attendeeEmail}\nSubject: ${draft.subject}\nBody: ${body}`,
  });

  return { pattern: 'calendar-then-gmail-pronoun', status: overallStatus(steps), steps, summaryText: summarize(steps) };
}

// ============================================================
// Pattern 4 — Calendar read + Tasks read, no dependency, combined summary
// ============================================================

// Checkpoint 21 fix — generalized from an exact "show...tasks...and...
// calendar...for X" regex to the shared concept+shape classifier: caught
// via real-backend testing, "What meetings and tasks do I have today?"
// and "Tell me what's on my calendar and task list today." (real natural
// paraphrases, not the literal example sentence) both failed to match the
// old regex and were then silently answered by Calendar's OWN
// single-capability classifier alone — exactly the "silently consumed by
// only one capability" failure mode this checkpoint must prevent. Any
// phrasing naming BOTH Calendar's and Tasks' concepts, asked personally,
// now triggers this pattern — no day phrase required (defaults to today,
// same as before).
async function tryCalendarTasksSummary(t: string, signal: AbortSignal | undefined, _sessionId: string): Promise<OrchestrationResult | null> {
  const compound = detectCompoundQuery(t);
  if (!compound || !compound.concepts.includes('calendar') || !compound.concepts.includes('tasks')) return null;
  // Gmail also mentioned alongside Calendar+Tasks isn't one of the 4
  // supported shapes — let the unsupported-compound fallback (below, in
  // tryOrchestration) handle it instead of silently only reading two of
  // the three named capabilities.
  if (compound.concepts.includes('gmail')) return null;

  const day = resolveDayPhrase(t) ?? { daysFromNow: 0, label: 'today' };

  const steps: OrchestrationStepResult[] = [];

  const calAvail = calendarAvailability();
  if (calAvail.available) {
    const calClient = getCalendarClient();
    const range = dayRangeIso(day.daysFromNow);
    try {
      const events = await calClient.listEvents(range.start, range.end, DEFAULT_TIMEZONE, 20, signal);
      steps.push({
        id: 'read-calendar',
        capability: 'calendar',
        description: 'Read calendar',
        status: 'completed',
        resultText: events.length ? events.map((e) => `• ${e.title} — ${formatLocal(e.start, DEFAULT_TIMEZONE)}`).join('\n') : 'No events found.',
      });
    } catch (e: any) {
      if (isAbortError(e) || signal?.aborted) throw e;
      steps.push({ id: 'read-calendar', capability: 'calendar', description: 'Read calendar', status: 'failed', resultText: `Calendar read failed: ${e?.message ?? 'unknown error'}` });
    }
  } else {
    steps.push({ id: 'read-calendar', capability: 'calendar', description: 'Read calendar', status: 'failed', resultText: calAvail.reason });
  }

  const tasksAvail = tasksAvailability();
  if (tasksAvail.available) {
    const tasksClient = getTasksClient();
    try {
      const all = await tasksClient.listTasks(tasksClient.defaultListId, 50, signal);
      const dueIso = taskDueIso(day.daysFromNow).slice(0, 10);
      const openThatDay = all.filter((x) => x.status !== 'completed' && (!x.due || x.due.slice(0, 10) === dueIso));
      steps.push({
        id: 'read-tasks',
        capability: 'tasks',
        description: 'Read tasks',
        status: 'completed',
        resultText: openThatDay.length ? openThatDay.map((x) => `• ${x.title}`).join('\n') : 'No open tasks for that day.',
      });
    } catch (e: any) {
      if (isAbortError(e) || signal?.aborted) throw e;
      steps.push({ id: 'read-tasks', capability: 'tasks', description: 'Read tasks', status: 'failed', resultText: `Tasks read failed: ${e?.message ?? 'unknown error'}` });
    }
  } else {
    steps.push({ id: 'read-tasks', capability: 'tasks', description: 'Read tasks', status: 'failed', resultText: tasksAvail.reason });
  }

  const summaryText = `CALENDAR (${day.label}):\n${steps.find((s) => s.id === 'read-calendar')?.resultText}\n\nTASKS STILL OPEN (${day.label}):\n${steps.find((s) => s.id === 'read-tasks')?.resultText}`;
  return { pattern: 'calendar-tasks-summary', status: overallStatus(steps), steps, summaryText };
}

const PATTERNS = [tryCalendarThenTaskAfterMeeting, tryGmailThenTaskReply, tryCalendarThenGmailPronoun, tryCalendarTasksSummary];

const CONCEPT_LABEL: Record<CapabilityConcept, string> = { calendar: 'Calendar', gmail: 'Gmail', tasks: 'Tasks' };

/**
 * Checkpoint 21 fix — the critical safety net: "a compound personal
 * request must never be silently consumed by only one capability when
 * another requested capability is clearly present." If none of the 4
 * supported patterns matched, but the text still clearly names 2+
 * capability concepts in a personal-query way (detectCompoundQuery), this
 * is NOT single-capability routing's to silently narrow to whichever one
 * concept it happens to recognize — and it's NOT a browser task either.
 * Says so explicitly instead of guessing which half of the request to
 * drop. No mutation, no read, nothing pending — a pure "I can't do this
 * combination yet" response.
 */
function buildUnsupportedCompoundResult(concepts: CapabilityConcept[]): OrchestrationResult {
  const names = concepts.map((c) => CONCEPT_LABEL[c]).join(' and ');
  const resultText = `This looks like a request involving both ${names}, but I don't have a supported way to handle that specific combination together yet. Try asking about each one separately — for example, ask about ${CONCEPT_LABEL[concepts[0]]} and ${CONCEPT_LABEL[concepts[1]]} in two separate requests.`;
  return {
    pattern: 'unsupported-compound',
    status: 'blocked',
    steps: concepts.map((c) => ({ id: `unsupported-${c}`, capability: c, description: `${CONCEPT_LABEL[c]} portion of a compound request`, status: 'skipped_dependency' as const, resultText: 'Not attempted — this compound combination is not yet supported; never guessed which half to answer.' })),
    summaryText: resultText,
  };
}

/**
 * Tries each fixed pattern in turn (cheap, synchronous regex reject before
 * any real work) and returns the first match's execution result. If none
 * matched but the text is still clearly a compound multi-capability
 * personal query, returns the explicit unsupported-combination result
 * (see buildUnsupportedCompoundResult) rather than null — this is the ONE
 * case where tryOrchestration's non-null return isn't one of the 4
 * supported patterns, and it deliberately never reaches single-capability
 * or browser routing. Returns null only when nothing in this small
 * supported grammar, AND no compound-query shape, applies at all —
 * callers fall through to the existing single-capability/browser routing,
 * completely unchanged from before this checkpoint.
 */
export async function tryOrchestration(goal: string, signal: AbortSignal | undefined, sessionId: string): Promise<OrchestrationResult | null> {
  const t = goal.trim();
  for (const pattern of PATTERNS) {
    const result = await pattern(t, signal, sessionId);
    if (result) return result;
  }
  const compound = detectCompoundQuery(t);
  if (compound) return buildUnsupportedCompoundResult(compound.concepts);
  return null;
}
