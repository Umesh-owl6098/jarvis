/**
 * Checkpoint 26 (narrow extraction) — the deterministic workflow grammar
 * itself: every fixed pattern's regex, its matched execution (each pattern
 * function interleaves "does this text match" with "run the capability
 * calls this match implies," since the two are not meaningfully separable
 * — a pattern's captured clauses immediately drive which capability calls
 * happen, and dependency decisions like "was the meeting found?" can only
 * be made mid-execution, not from the text alone), the two shared
 * Calendar/Contacts lookup helpers reused by more than one pattern, and
 * the narrow unsupported-compound/unsupported-action safety nets.
 *
 * Moved out of orchestrator.ts unchanged (Checkpoint 26 architecture
 * review) — orchestrator.ts remains the thin public entry point /
 * precedence dispatcher (PATTERNS + the two "unsupported" builders below,
 * tried in order); this file is where "what counts as a supported
 * workflow, and what capability calls it makes" actually lives. No
 * behavior, grammar, or safety semantics changed by this move — see
 * orchestrator.ts's own header for the full precedence description.
 */

import { detectCalendarIntent } from '@/core/capabilities/calendar/intent';
import { runCalendarIntent } from '@/core/capabilities/calendar/runner';
import { getCalendarClient, calendarAvailability } from '@/core/capabilities/calendar/resolve';
import { calendarPendingActionStore } from '@/core/capabilities/calendar/pending-action';
import { resolveDayPhrase, dayRangeIso, formatLocal, DEFAULT_TIMEZONE } from '@/core/capabilities/calendar/datetime';
import type { CalendarClient, CalendarEvent } from '@/core/capabilities/calendar/types';

import { detectGmailIntent } from '@/core/capabilities/gmail/intent';
import { runGmailIntent } from '@/core/capabilities/gmail/runner';
import { getGmailClient, gmailAvailability } from '@/core/capabilities/gmail/resolve';
import { pendingActionStore } from '@/core/capabilities/gmail/pending-action';

import { getTasksClient, tasksAvailability } from '@/core/capabilities/tasks/resolve';
import { tasksPendingActionStore } from '@/core/capabilities/tasks/pending-action';
import { taskDueIso, formatDueDate } from '@/core/capabilities/tasks/datetime';
import type { TaskProposal } from '@/core/capabilities/tasks/types';

import { resolvePerson, describeUnresolved, summarize as summarizeResolution, type ResolutionSummary } from '@/core/capabilities/contacts/resolver';
import { getContactsClient, contactsAvailability } from '@/core/capabilities/contacts/resolve';

import { detectCompoundQuery, type CapabilityConcept } from '@/core/capabilities/shared/compound-classifier';

import type { OrchestrationStepStatus, OrchestrationStepResult, OrchestrationResult } from './workflow-types';

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

/**
 * Checkpoint 26 — the sequencing vocabulary shared by every pattern below:
 * "and", "then", "and then", "after that", OR a bare comma in an Oxford-
 * comma-style list ("A, B, and C" — only the LAST item needs the word
 * "and"; earlier items are comma-only, e.g. "Find my meeting with GV
 * tomorrow, draft him an email saying X, and remind me to Y."). This is
 * NOT a general clause splitter — it is only ever used as the join point
 * inside a pattern's OWN regex, immediately followed by that pattern's own
 * specific, narrow trigger phrase ("remind me to"/"draft ... an
 * email"/"email him"/etc). This is exactly what keeps "Schedule lunch
 * with Alice and Bob tomorrow" from ever being split: "Bob tomorrow"
 * doesn't start with any supported trigger phrase, so no pattern's regex
 * matches at that "and", and the whole sentence falls through to
 * Calendar's own single-capability parsing untouched, as one operation
 * with two attendees.
 */
const SEQ = String.raw`(?:\s*,\s*(?:and\s+then\s+|after\s+that\s+|then\s+|and\s+)?|\s+(?:and\s+then|after\s+that|then|and)\s+)`;

// ============================================================
// Pattern 1 — Calendar read -> Tasks proposal, "after my last/first meeting"
// ============================================================

const AFTER_MEETING_RE = new RegExp(`^(.+?)${SEQ}remind me to\\s+(.+?)\\s+after\\s+(?:my\\s+)?(last|first)\\s+meeting\\b.*$`, 'i');

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

// Checkpoint 26 — generalized: the original CP21 shape ("X and create a
// task to Y") is a strict subset of this — "remind me to"/"add a task to"
// are the other two natural phrasings the CP26 spec's own examples use
// ("Find my latest email from GV and remind me to reply tomorrow.",
// "Check my latest email from GV, then add a task to follow up Friday.").
const REPLY_TASK_RE = new RegExp(`^(.+?)${SEQ}(?:remind me to|add a task to|create a task to)\\s+(.+)$`, 'i');

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

// Checkpoint 26 — generalized conjunction (was bare "and" only) and
// trigger vocabulary (added "email {pronoun}", alongside the original
// "draft an email telling/to {pronoun}") — the CP26 spec's own Calendar-
// then-Gmail examples use both phrasings ("draft him an email saying
// I'll be there", "email him asking if 3 PM works").
const CAL_THEN_EMAIL_RE = new RegExp(`^(.+?)${SEQ}(?:draft (?:an? )?email\\s+(?:telling|to)\\s+(?:them|him|her)|email\\s+(?:them|him|her))\\b(.*)$`, 'i');

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

// ============================================================
// Checkpoint 26 — Pattern 5: Calendar read (last/first meeting named
// WITHIN the calendar clause itself) -> Tasks proposal. Generalizes
// Pattern 1 above (which requires the exact "remind me to X AFTER my
// last/first meeting" phrase) to the equally natural "Find my last
// meeting tomorrow and remind me to send notes afterward." shape, where
// "last/first" already qualifies the calendar clause and the task clause
// is otherwise independent. Reuses the exact same date-only-Tasks
// honesty discipline as Pattern 1 — never fabricates a trigger time.
// ============================================================

const CAL_LAST_FIRST_RE = /\b(last|first)\s+meeting\b/i;
const CAL_LAST_FIRST_THEN_TASK_RE = new RegExp(`^(.+?)${SEQ}(?:remind me to|add a task to|create a task to)\\s+(.+)$`, 'i');

async function tryCalendarLastFirstThenTask(t: string, signal: AbortSignal | undefined, sessionId: string): Promise<OrchestrationResult | null> {
  const m = CAL_LAST_FIRST_THEN_TASK_RE.exec(t);
  if (!m) return null;
  const calClause = m[1].replace(/[,.]+$/, '').trim();
  const taskAction = m[2].trim();

  const whichMatch = CAL_LAST_FIRST_RE.exec(calClause);
  if (!whichMatch) return null; // no last/first qualifier in the calendar clause — not this pattern, let Pattern 1/2 or normal routing handle it
  const which = whichMatch[1].toLowerCase() as 'last' | 'first';

  const calIntent = detectCalendarIntent(calClause);
  if (!calIntent || calIntent.operation !== 'list') return null;

  const steps: OrchestrationStepResult[] = [];

  const calAvail = calendarAvailability();
  if (!calAvail.available) {
    steps.push({ id: 'read-calendar', capability: 'calendar', description: 'Read calendar', status: 'failed', resultText: calAvail.reason });
    steps.push({ id: 'create-task', capability: 'tasks', description: 'Prepare reminder task', status: 'skipped_dependency', resultText: 'Skipped — the calendar read this depends on could not run.' });
    return { pattern: 'calendar-last-first-then-task', status: 'failed', steps, summaryText: summarize(steps) };
  }

  const calClient = getCalendarClient();
  let events;
  try {
    events = await calClient.listEvents(calIntent.rangeStart!, calIntent.rangeEnd!, calIntent.timezone, 50, signal);
  } catch (e: any) {
    if (isAbortError(e) || signal?.aborted) throw e;
    steps.push({ id: 'read-calendar', capability: 'calendar', description: 'Read calendar', status: 'failed', resultText: `Calendar read failed: ${e?.message ?? 'unknown error'}` });
    steps.push({ id: 'create-task', capability: 'tasks', description: 'Prepare reminder task', status: 'skipped_dependency', resultText: 'Skipped — the calendar read this depends on failed.' });
    return { pattern: 'calendar-last-first-then-task', status: 'failed', steps, summaryText: summarize(steps) };
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
      resultText: `Skipped — no meetings were found, so "${which} meeting" can't be resolved. Never guessed.`,
    });
    return { pattern: 'calendar-last-first-then-task', status: 'blocked', steps, summaryText: summarize(steps) };
  }

  const sorted = [...events].sort((a, b) => (a.start < b.start ? -1 : 1));
  const targetEvent = which === 'last' ? sorted[sorted.length - 1] : sorted[0];

  const tasksAvail = tasksAvailability();
  if (!tasksAvail.available) {
    steps.push({ id: 'create-task', capability: 'tasks', description: 'Prepare reminder task', status: 'failed', resultText: tasksAvail.reason });
    return { pattern: 'calendar-last-first-then-task', status: 'failed', steps, summaryText: summarize(steps) };
  }

  const tasksClient = getTasksClient();
  const dayPhrase = resolveDayPhrase(calClause) ?? { daysFromNow: 0, label: 'today' };
  const due = taskDueIso(dayPhrase.daysFromNow);
  const title = taskAction.charAt(0).toUpperCase() + taskAction.slice(1).replace(/[.,!?]+$/, '');
  // §29-style honesty, same as Pattern 1 — Tasks' `due` is DATE-ONLY.
  const notes = `Context: your ${which} meeting that day — "${targetEvent.title}" (${formatLocal(targetEvent.start, calIntent.timezone)}–${formatLocal(targetEvent.end, calIntent.timezone)}). Google Tasks only supports a due DATE, not a specific time, so this will NOT trigger automatically right after that meeting ends.`;

  const proposal: TaskProposal = { kind: 'create', title, notes, due, taskListId: tasksClient.defaultListId };
  tasksPendingActionStore.set(sessionId, { type: 'tasks_create', proposal, createdAt: Date.now() });

  steps.push({
    id: 'create-task',
    capability: 'tasks',
    description: 'Prepare reminder task',
    status: 'pending_confirmation',
    resultText: `TASK READY FOR CONFIRMATION\n\nTASK: ${title}\nDUE DATE: ${formatDueDate(due)}\n${notes}`,
  });

  return { pattern: 'calendar-last-first-then-task', status: overallStatus(steps), steps, summaryText: summarize(steps) };
}

// ============================================================
// Checkpoint 26 — Pattern 5b: Calendar CREATE + Tasks CREATE, fully
// INDEPENDENT (no shared data — "Schedule a meeting tomorrow and create a
// task to prepare." produces TWO separate mutation proposals; the task
// does not reference the meeting at all). Distinct from every pattern
// above, which all encode a genuine one-way data dependency (an
// attendee, a found event, a found email) — here, if one side fails, the
// OTHER is still attempted independently, since neither depends on the
// other's result. This is the shape the checkpoint's own "Multiple
// mutations in one workflow" requirement demonstrates.
// ============================================================

async function tryCalendarCreateThenIndependentTask(t: string, signal: AbortSignal | undefined, sessionId: string): Promise<OrchestrationResult | null> {
  const m = CAL_LAST_FIRST_THEN_TASK_RE.exec(t);
  if (!m) return null;
  const calClause = m[1].replace(/[,.]+$/, '').trim();
  const taskAction = m[2].trim();
  if (!taskAction) return null;

  // Only fires for a genuine CREATE ("schedule a meeting..."), never a
  // list/read (Pattern 5 above already claims that shape) — and never
  // when the calendar clause itself names a last/first meeting (Pattern
  // 5's own territory).
  if (CAL_LAST_FIRST_RE.test(calClause)) return null;
  const calIntent = detectCalendarIntent(calClause);
  if (!calIntent || calIntent.operation !== 'propose_create') return null;

  const steps: OrchestrationStepResult[] = [];

  // ---- Calendar half (independent) ----
  const calAvail = calendarAvailability();
  if (!calAvail.available) {
    steps.push({ id: 'propose-event', capability: 'calendar', description: 'Prepare calendar proposal', status: 'failed', resultText: calAvail.reason });
  } else {
    try {
      const calClient = getCalendarClient();
      const calOutcome = await runCalendarIntent(calIntent, calClient, signal);
      if (calOutcome.status === 'completed' && calOutcome.proposalCreated) {
        calendarPendingActionStore.set(sessionId, { type: 'calendar_create', proposal: calOutcome.proposalCreated.proposal, createdAt: Date.now() });
        steps.push({ id: 'propose-event', capability: 'calendar', description: 'Prepare calendar proposal', status: 'pending_confirmation', resultText: calOutcome.resultText });
      } else {
        steps.push({ id: 'propose-event', capability: 'calendar', description: 'Prepare calendar proposal', status: 'failed', resultText: calOutcome.resultText });
      }
    } catch (e: any) {
      if (isAbortError(e) || signal?.aborted) throw e;
      steps.push({ id: 'propose-event', capability: 'calendar', description: 'Prepare calendar proposal', status: 'failed', resultText: `Calendar operation failed: ${e?.message ?? 'unknown error'}` });
    }
  }

  // ---- Tasks half (independent — never reads anything from the calendar step) ----
  const tasksAvail = tasksAvailability();
  if (!tasksAvail.available) {
    steps.push({ id: 'create-task', capability: 'tasks', description: 'Prepare task', status: 'failed', resultText: tasksAvail.reason });
  } else {
    const tasksClient = getTasksClient();
    const dayPhrase = resolveDayPhrase(taskAction) ?? resolveDayPhrase(calClause) ?? { daysFromNow: 1, label: 'tomorrow' };
    const due = taskDueIso(dayPhrase.daysFromNow);
    const title = taskAction.charAt(0).toUpperCase() + taskAction.slice(1).replace(/[.,!?]+$/, '');
    const proposal: TaskProposal = { kind: 'create', title, due, taskListId: tasksClient.defaultListId };
    tasksPendingActionStore.set(sessionId, { type: 'tasks_create', proposal, createdAt: Date.now() });
    steps.push({ id: 'create-task', capability: 'tasks', description: 'Prepare task', status: 'pending_confirmation', resultText: `TASK READY FOR CONFIRMATION\n\nTASK: ${title}\nDUE DATE: ${formatDueDate(due)}` });
  }

  return { pattern: 'calendar-create-independent-task', status: overallStatus(steps), steps, summaryText: summarize(steps) };
}

// ============================================================
// Checkpoint 26 — shared helper: deterministically finds "my meeting with
// <personName>" for the two patterns below (Calendar-existing-meeting ->
// Gmail, and the 3-step Calendar -> Gmail -> Tasks chain). Resolves the
// person via Contacts FIRST — never guesses an attendee from a bare
// title/string match — then looks for an event, within the given day (if
// a day phrase was present) or a rolling 14-day forward window otherwise,
// whose attendees include that resolved email. Exactly one match wins;
// zero, or 2+ with no last/first/next qualifier, is reported as a typed
// failure, never guessed — mirrors Pattern 3's existing "ambiguous
// contact blocks the dependent Gmail step" discipline.
// ============================================================

type MeetingLookupResult =
  | { ok: true; event: CalendarEvent; attendeeEmail: string; resolution: ResolutionSummary }
  | { ok: false; kind: 'contact_unresolved'; reason: string; resolution: ResolutionSummary }
  | { ok: false; kind: 'no_match' | 'ambiguous_meeting'; reason: string };

async function findMeetingWithPerson(
  personName: string,
  dayPhrase: { daysFromNow: number; label: string } | null,
  which: 'last' | 'first' | null,
  client: CalendarClient,
  signal: AbortSignal | undefined
): Promise<MeetingLookupResult> {
  const contactsAvail = contactsAvailability();
  if (!contactsAvail.available) {
    // Contacts unavailable — falls through exactly like every other
    // capability's own "no name resolution attempted" path; never invents
    // an attendee from the bare name string.
    return { ok: false, kind: 'no_match', reason: `Could not resolve "${personName}" to a contact — Contacts is not connected.` };
  }
  const personResolution = await resolvePerson(personName, getContactsClient(), signal);
  const resolution = summarizeResolution(personResolution);
  if (personResolution.status !== 'resolved') {
    return { ok: false, kind: 'contact_unresolved', reason: describeUnresolved(personResolution), resolution };
  }
  const email = personResolution.email;

  const range = dayPhrase ? dayRangeIso(dayPhrase.daysFromNow) : { start: new Date().toISOString(), end: new Date(Date.now() + 14 * 86400000).toISOString() };
  const events = await client.listEvents(range.start, range.end, DEFAULT_TIMEZONE, 50, signal);
  const matches = events.filter((e) => e.attendees.includes(email));
  if (matches.length === 0) {
    return { ok: false, kind: 'no_match', reason: `No meeting with ${personName} was found${dayPhrase ? ` ${dayPhrase.label}` : ' in the next two weeks'}.` };
  }
  if (matches.length === 1) {
    return { ok: true, event: matches[0], attendeeEmail: email, resolution };
  }
  const sorted = [...matches].sort((a, b) => (a.start < b.start ? -1 : 1));
  if (which === 'last') return { ok: true, event: sorted[sorted.length - 1], attendeeEmail: email, resolution };
  if (which === 'first') return { ok: true, event: sorted[0], attendeeEmail: email, resolution };
  return { ok: false, kind: 'ambiguous_meeting', reason: `Multiple meetings with ${personName} were found — please say "the first" or "the last" one, or narrow the day.` };
}

// Deliberately case-SENSITIVE (no /i flag) — mirrors calendar/intent.ts's
// own attendeeNameFrom() exactly, for the same reason: with /i, [A-Z]
// would match a lowercase word too (e.g. "tomorrow"), so "meeting with
// Alice tomorrow" would wrongly capture "Alice tomorrow" as the name via
// the optional second-word group. Requiring a real capital letter is what
// keeps the day/time word that typically follows a name out of the match.
const MEETING_WITH_RE = /\bmeeting\s+with\s+([A-Z][\w'-]*(?:\s+[A-Z][\w'-]*)?)\b/;
const WHICH_QUALIFIER_RE = /\b(next|last|first)\s+meeting\b/i;

/**
 * Runs the shared "find the meeting with a named person, then draft them
 * an email" two-step core, reused by both the 2-step pattern (below) and
 * the 3-step chain. Returns an empty steps array when `calClause` doesn't
 * even name a person via "meeting with X" — the caller reads this as "not
 * this pattern" and returns null, exactly like every other pattern's own
 * regex-reject-first discipline.
 */
async function runCalendarMeetingThenGmailSteps(
  calClause: string,
  gmailBody: string,
  signal: AbortSignal | undefined,
  sessionId: string
): Promise<{ steps: OrchestrationStepResult[]; attendeeEmail: string | null }> {
  const personMatch = MEETING_WITH_RE.exec(calClause);
  if (!personMatch) return { steps: [], attendeeEmail: null };
  const personName = personMatch[1];
  const whichRaw = WHICH_QUALIFIER_RE.exec(calClause)?.[1].toLowerCase() as 'next' | 'last' | 'first' | undefined;
  // "next" meeting == chronologically FIRST upcoming match within the window.
  const which: 'last' | 'first' | null = whichRaw === 'last' ? 'last' : whichRaw ? 'first' : null;
  const dayPhrase = resolveDayPhrase(calClause);

  const steps: OrchestrationStepResult[] = [];

  const calAvail = calendarAvailability();
  if (!calAvail.available) {
    steps.push({ id: 'read-calendar', capability: 'calendar', description: 'Find meeting', status: 'failed', resultText: calAvail.reason });
    steps.push({ id: 'draft-email', capability: 'gmail', description: 'Draft email', status: 'skipped_dependency', resultText: 'Skipped — the calendar lookup this depends on could not run.' });
    return { steps, attendeeEmail: null };
  }

  const calClient = getCalendarClient();
  let lookup: MeetingLookupResult;
  try {
    lookup = await findMeetingWithPerson(personName, dayPhrase, which, calClient, signal);
  } catch (e: any) {
    if (isAbortError(e) || signal?.aborted) throw e;
    steps.push({ id: 'read-calendar', capability: 'calendar', description: 'Find meeting', status: 'failed', resultText: `Calendar lookup failed: ${e?.message ?? 'unknown error'}` });
    steps.push({ id: 'draft-email', capability: 'gmail', description: 'Draft email', status: 'skipped_dependency', resultText: 'Skipped — the calendar lookup this depends on failed.' });
    return { steps, attendeeEmail: null };
  }

  if (!lookup.ok) {
    // A genuinely ambiguous/unresolved Contacts match is reported exactly
    // like Pattern 3's own precedent (calendar step 'failed', since the
    // lookup itself couldn't proceed meaningfully); a clean zero/ambiguous
    // CALENDAR match still means the read itself worked — reported
    // 'completed' with an honest "not found" resultText, same discipline
    // Pattern 1/5 already use for "no events found."
    const status: OrchestrationStepStatus = lookup.kind === 'contact_unresolved' ? 'failed' : 'completed';
    steps.push({ id: 'read-calendar', capability: 'calendar', description: 'Find meeting', status, resultText: lookup.reason });
    steps.push({
      id: 'draft-email',
      capability: 'gmail',
      description: 'Draft email',
      status: 'skipped_dependency',
      resultText: 'Skipped — the meeting/attendee this depends on could not be resolved. Never guessed a recipient.',
    });
    return { steps, attendeeEmail: null };
  }

  steps.push({
    id: 'read-calendar',
    capability: 'calendar',
    description: 'Find meeting',
    status: 'completed',
    resultText: `Found "${lookup.event.title}" with ${personName} — ${formatLocal(lookup.event.start, lookup.event.timezone)} to ${formatLocal(lookup.event.end, lookup.event.timezone)}.`,
  });

  const gAvail = gmailAvailability();
  if (!gAvail.available) {
    steps.push({ id: 'draft-email', capability: 'gmail', description: 'Draft email', status: 'failed', resultText: gAvail.reason });
    return { steps, attendeeEmail: null };
  }

  const gmailClient = getGmailClient();
  const body = gmailBody.replace(/[.,!?]+$/g, '').trim();
  let draft;
  try {
    draft = await gmailClient.createDraft([lookup.attendeeEmail], '(no subject)', body, undefined, signal);
  } catch (e: any) {
    if (isAbortError(e) || signal?.aborted) throw e;
    steps.push({ id: 'draft-email', capability: 'gmail', description: 'Draft email', status: 'failed', resultText: `Draft creation failed: ${e?.message ?? 'unknown error'}` });
    return { steps, attendeeEmail: null };
  }
  pendingActionStore.set(sessionId, { type: 'gmail_send', draftId: draft.draftId, recipient: [lookup.attendeeEmail], subject: draft.subject, createdAt: Date.now() });

  steps.push({
    id: 'draft-email',
    capability: 'gmail',
    description: 'Draft email',
    status: 'pending_confirmation',
    // A real Gmail draft object now exists — draft creation was never
    // confirmation-gated (Checkpoint 17), only SEND is.
    remoteWriteOccurred: true,
    resultText: `DRAFT CREATED\n\nTo: ${lookup.attendeeEmail}\nSubject: ${draft.subject}\nBody: ${body || '(empty)'}`,
  });

  return { steps, attendeeEmail: lookup.attendeeEmail };
}

// ============================================================
// Checkpoint 26 — Pattern 6: Calendar (find an EXISTING meeting) -> Gmail
// draft to that meeting's resolved attendee. Distinct from Pattern 3
// above, which only handles CREATING a brand-new meeting then emailing
// the newly-resolved attendee — this handles "Find my meeting with GV
// tomorrow and draft him an email saying I'll be there." (a READ, not a
// create), which Pattern 3's propose_create gate never matches.
// ============================================================

const CAL_MEETING_THEN_GMAIL_RE = new RegExp(
  `^(.+?)${SEQ}(?:draft\\s+(?:them|him|her)\\s+an\\s+email(?:\\s+saying)?|email\\s+(?:them|him|her)(?:\\s+(?:saying|asking))?)\\s+(.+)$`,
  'i'
);

async function tryCalendarMeetingThenGmail(t: string, signal: AbortSignal | undefined, sessionId: string): Promise<OrchestrationResult | null> {
  const m = CAL_MEETING_THEN_GMAIL_RE.exec(t);
  if (!m) return null;
  const calClause = m[1].replace(/[,.]+$/, '').trim();
  const gmailBody = m[2].trim();
  if (!gmailBody) return null;

  const { steps, attendeeEmail } = await runCalendarMeetingThenGmailSteps(calClause, gmailBody, signal, sessionId);
  if (steps.length === 0) return null; // calClause didn't name "meeting with X" at all — not this pattern
  void attendeeEmail;

  return { pattern: 'calendar-meeting-then-gmail', status: overallStatus(steps), steps, summaryText: summarize(steps) };
}

// ============================================================
// Checkpoint 26 — Pattern 7 (the main CP26 demonstration): Calendar (find
// an existing meeting) -> Gmail draft to its attendee -> Tasks proposal.
// Reuses runCalendarMeetingThenGmailSteps for steps 1-2 unchanged, then
// appends a third Tasks step exactly like Pattern 2's own task-building
// logic. Tried BEFORE Pattern 6 in the PATTERNS list (see below) — Pattern
// 6's own Gmail-body capture is unbounded (`.+$`) and would otherwise
// swallow a trailing ", and remind me to..." clause into the email body.
// ============================================================

const CAL_MEETING_GMAIL_TASK_RE = new RegExp(
  `^(.+?)${SEQ}(?:draft\\s+(?:them|him|her)\\s+an\\s+email(?:\\s+saying)?|email\\s+(?:them|him|her)(?:\\s+(?:saying|asking))?)\\s+(.+?)${SEQ}(?:remind me to|add a task to|create a task to)\\s+(.+)$`,
  'i'
);

async function tryCalendarGmailTasksChain(t: string, signal: AbortSignal | undefined, sessionId: string): Promise<OrchestrationResult | null> {
  const m = CAL_MEETING_GMAIL_TASK_RE.exec(t);
  if (!m) return null;
  const calClause = m[1].replace(/[,.]+$/, '').trim();
  const gmailBody = m[2].trim();
  const taskAction = m[3].trim();
  if (!gmailBody || !taskAction) return null;

  const { steps, attendeeEmail } = await runCalendarMeetingThenGmailSteps(calClause, gmailBody, signal, sessionId);
  if (steps.length === 0) return null; // calClause didn't name "meeting with X" at all — not this pattern

  if (!attendeeEmail) {
    // Calendar/Gmail step already failed or was skipped — the dependent
    // Task step is skipped too, never created against unresolved context.
    steps.push({
      id: 'create-task',
      capability: 'tasks',
      description: 'Prepare follow-up task',
      status: 'skipped_dependency',
      resultText: 'Skipped — an earlier step in this workflow did not complete, so there is nothing concrete for this task to reference.',
    });
    return { pattern: 'calendar-gmail-tasks-chain', status: overallStatus(steps), steps, summaryText: summarize(steps) };
  }

  const tasksAvail = tasksAvailability();
  if (!tasksAvail.available) {
    steps.push({ id: 'create-task', capability: 'tasks', description: 'Prepare follow-up task', status: 'failed', resultText: tasksAvail.reason });
    return { pattern: 'calendar-gmail-tasks-chain', status: overallStatus(steps), steps, summaryText: summarize(steps) };
  }

  const tasksClient = getTasksClient();
  const dayPhrase = resolveDayPhrase(taskAction) ?? { daysFromNow: 1, label: 'tomorrow' };
  const due = taskDueIso(dayPhrase.daysFromNow);
  const title = taskAction.charAt(0).toUpperCase() + taskAction.slice(1).replace(/[.,!?]+$/, '');

  const proposal: TaskProposal = { kind: 'create', title, due, taskListId: tasksClient.defaultListId };
  tasksPendingActionStore.set(sessionId, { type: 'tasks_create', proposal, createdAt: Date.now() });

  steps.push({
    id: 'create-task',
    capability: 'tasks',
    description: 'Prepare follow-up task',
    status: 'pending_confirmation',
    resultText: `TASK READY FOR CONFIRMATION\n\nTASK: ${title}\nDUE DATE: ${formatDueDate(due)}`,
  });

  return { pattern: 'calendar-gmail-tasks-chain', status: overallStatus(steps), steps, summaryText: summarize(steps) };
}

/**
 * Precedence order — most-specific-first. Pattern 7 (3-step chain) MUST be
 * tried before Pattern 6 (2-step): Pattern 6's Gmail-body capture is
 * unbounded and would otherwise swallow a trailing ", and remind me to..."
 * clause into the email body. This ordering constraint is exactly why the
 * array lives next to the pattern functions rather than in orchestrator.ts
 * — moving one without the other would be easy to get wrong.
 */
export const PATTERNS = [
  tryCalendarGmailTasksChain, // most specific (3 steps) tried first — see its own comment on why
  tryCalendarThenTaskAfterMeeting,
  tryCalendarLastFirstThenTask,
  tryCalendarCreateThenIndependentTask,
  tryGmailThenTaskReply,
  tryCalendarThenGmailPronoun,
  tryCalendarMeetingThenGmail,
  tryCalendarTasksSummary,
];

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
export function buildUnsupportedCompoundResult(concepts: CapabilityConcept[]): OrchestrationResult {
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
 * Checkpoint 26 — a small, deliberately NARROW second safety net,
 * separate from buildUnsupportedCompoundResult above. That one only ever
 * fires for a personal-QUERY shape (see compound-classifier.ts's own
 * comment — "never for a mutation-trigger phrase"), so it can't catch an
 * IMPERATIVE compound like "Check my email and transfer $500." — a real
 * concept word (email) IS present, but "transfer $500" names no
 * capability concept at all, so detectConcepts() only ever sees length 1
 * and detectCompoundQuery() never fires, leaving Gmail's own single-
 * capability fallback to silently answer just the email half.
 *
 * Deliberately NOT a general clause splitter (the checkpoint's own "small
 * deterministic grammar, not a clever general parser" constraint,
 * applied here too) — this is a small, curated list of common non-
 * capability action verbs paired with a nearby DOLLAR AMOUNT, which is
 * specific enough to never fire on an ordinary sentence ("Schedule lunch
 * with Alice and Bob tomorrow" contains none of these verbs at all) while
 * still catching the checkpoint's own explicit example.
 *
 * Checkpoint 26 architecture review — the `$` is REQUIRED (not optional).
 * An earlier version made it optional, which let a bare number falsely
 * trigger this on ordinary sentences that happen to contain one of these
 * common English words near ANY digit: "Find my email about order 500"
 * ("order 500" — an order number, not a purchase), "What's my order
 * number 500", "Pay attention to the meeting at 5" (matched the entire
 * clause up to "5"), "What's my pay rate for 500 hours". Every one of the
 * checkpoint's own examples already includes a literal "$", so requiring
 * it costs nothing while eliminating this whole false-positive class —
 * see test-cp26-workflow-parsing.ts tests 8d-8h.
 */
export const UNSUPPORTED_ACTION_RE = /\b(?:transfer|wire|pay|send\s+money|purchase|order)\b[^.!?]{0,40}?\$\d[\d,]*(?:\.\d+)?/i;

export function buildUnsupportedActionResult(concept: CapabilityConcept, actionText: string): OrchestrationResult {
  const resultText = `This looks like a request that includes "${actionText.trim()}", which isn't something I can do — I only have Gmail/Calendar/Tasks capabilities. I did not act on any part of this request; ask about ${CONCEPT_LABEL[concept]} separately if that's what you need.`;
  return {
    pattern: 'unsupported-action',
    status: 'blocked',
    steps: [
      { id: `supported-${concept}`, capability: concept, description: `${CONCEPT_LABEL[concept]} portion of the request`, status: 'skipped_dependency', resultText: 'Not attempted — the overall request includes an unsupported action, so nothing was executed.' },
      { id: 'unsupported-action', capability: concept, description: 'Unsupported action', status: 'failed', resultText: `"${actionText.trim()}" is not a capability JARVIS has.` },
    ],
    summaryText: resultText,
  };
}
