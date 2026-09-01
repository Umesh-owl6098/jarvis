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
 * none of this module's trigger phrasings match any capability's own
 * command vocabulary, so it's safe to try first and simply return null
 * when it doesn't apply.
 *
 * Checkpoint 25 — extends this SAME mechanism (no second, competing
 * revision architecture) with:
 *   - a broader, still-bounded trigger vocabulary ("change it to X",
 *     "move it to X", "update it to X", "actually say X", alongside the
 *     original "make it/that X");
 *   - Calendar DURATION revision, and combined date+time+duration in one
 *     turn — see reviseCalendar's new `durationMinutes` parameter;
 *   - Tasks TITLE revision (conservative: only when Tasks is the sole
 *     capability with something revisable pending — see the free-text
 *     branch in attemptProposalRevision);
 *   - general Gmail BODY revision ("change it to say X" / "actually say
 *     X") alongside the original "shorter" truncation heuristic;
 *   - a small, session-scoped, TTL-bounded "which capability did you
 *     mean?" memory (ambiguitySessions below) for the one case where a
 *     bare day-only change is genuinely ambiguous between a pending
 *     Calendar and a pending Tasks action — deliberately NOT folded into
 *     pending-slot.ts's gmail_draft_body/calendar_datetime union: that
 *     store answers "what value fills this missing field," this answers
 *     "which capability does this value apply to" — a different question,
 *     asked only in the narrow multi-pending-revision case, with its own
 *     independent TTL. Distinct state machines for distinct questions, not
 *     a conflicting one.
 *
 * Every new revision function below follows the EXACT same discipline the
 * original two already established: read the current PendingAction,
 * spread it, overwrite ONLY the field(s) the user's own current turn named
 * explicitly, call the store's .set() (which overwrites in place — same
 * draftId/same logical proposal, never a second one), and never touch a
 * capability's own confirmation/mutation call. A stored preference
 * (meetingDurationMinutes etc.) is never consulted here — only the
 * CURRENT turn's own explicit text, or the proposal's own prior value.
 */

import type { ExecutionResult } from './executor';
import type { EventListener } from './events';
import { nanoid } from 'nanoid';

import { calendarPendingActionStore } from '@/core/capabilities/calendar/pending-action';
import { resolveClockTime, resolveDayPhrase, resolveDurationMinutes, formatLocal } from '@/core/capabilities/calendar/datetime';
import type { CalendarProposal } from '@/core/capabilities/calendar/types';

import { tasksPendingActionStore } from '@/core/capabilities/tasks/pending-action';
import { taskDueIso, formatDueDate } from '@/core/capabilities/tasks/datetime';
import type { TaskProposal } from '@/core/capabilities/tasks/types';

import { pendingActionStore } from '@/core/capabilities/gmail/pending-action';
import { getGmailClient } from '@/core/capabilities/gmail/resolve';

// ============================================================
// Checkpoint 25 — session-scoped "which capability did you mean?" memory.
// Only ever populated by the bare day-only ambiguity case below; cleared
// on resolution, on expiry, or explicitly via clearRevisionAmbiguity
// (called from task-manager.ts's "Start over" handler, mirroring
// pending-slot.ts's own clear-on-start-over wiring).
// ============================================================

type RevisionCandidate = 'calendar' | 'tasks';

interface PendingRevisionAmbiguity {
  changeClause: string;
  candidates: RevisionCandidate[];
  createdAt: number;
}

const AMBIGUITY_TTL_MS = 5 * 60 * 1000; // matches the underlying PendingAction stores' own 5-minute TTL — the ambiguity is meaningless once what it refers to could itself have expired
const ambiguitySessions = new Map<string, PendingRevisionAmbiguity>();

function setAmbiguity(sessionId: string, changeClause: string, candidates: RevisionCandidate[]): void {
  ambiguitySessions.set(sessionId, { changeClause, candidates, createdAt: Date.now() });
}

function activeAmbiguity(sessionId: string): PendingRevisionAmbiguity | null {
  const a = ambiguitySessions.get(sessionId);
  if (!a) return null;
  if (Date.now() - a.createdAt > AMBIGUITY_TTL_MS) {
    ambiguitySessions.delete(sessionId);
    return null;
  }
  return a;
}

/** "Start over." also clears an outstanding "which capability?" question — same reasoning as pending-slot.ts's own clear-on-start-over. */
export function clearRevisionAmbiguity(sessionId: string): void {
  ambiguitySessions.delete(sessionId);
}

const CAPABILITY_REFERENCE_RE = /^(?:the\s+)?(meeting|event|calendar\s*event|calendar|task|reminder)\.?$/i;

/** Only meaningful immediately after activeAmbiguity() asked the question — a bare "the task." with nothing pending falls through to normal routing untouched. */
function referencedCapability(text: string): RevisionCandidate | null {
  const m = CAPABILITY_REFERENCE_RE.exec(text.trim());
  if (!m) return null;
  const word = m[1].toLowerCase();
  return word.startsWith('meeting') || word.startsWith('event') || word.startsWith('calendar') ? 'calendar' : 'tasks';
}

// ============================================================
// Trigger vocabulary
// ============================================================

// The "it"-referencing family — all explicitly reference an existing
// pending thing, so prefixing "actually," is safe (unlike a bare
// standalone "actually X", which risks swallowing a genuinely NEW command
// — see ACTUALLY_SAY_RE below for the one narrow standalone case this
// module supports instead).
const REVISION_LEAD_IN_RE = /^(?:actually,?\s*)?(?:make (?:that|it)|change it to|move it to|update it to)\s+(.+?)\.?$/i;
const SHORTER_RE = /^(?:a bit |a little )?shorter$/i;
const SAY_RE = /^say\s+(?:that\s+)?(.+)$/i;
// Standalone "actually say X" (no "make it"/"change it to" lead-in) — kept
// narrowly scoped to "say" specifically, exactly mirroring gmail/intent.ts's
// own extractFollowUpEmailBody wrapper-stripping discipline, so it can
// never be confused with "Actually email Priya" (a genuinely NEW Gmail
// command — see gmail/intent.ts's BARE_EMAIL_RE, which independently
// recognizes "actually email X" as its own bare-email trigger; this
// module's regexes simply never match that phrase at all, by construction).
const ACTUALLY_SAY_RE = /^actually,?\s+say\s+(?:that\s+)?(.+?)\.?$/i;

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

// ============================================================
// Calendar revision
// ============================================================

/**
 * Checkpoint 25 — revises the pending Calendar proposal's date, time,
 * and/or duration, whichever the CURRENT turn explicitly named; every
 * other field (title, attendees, location) is preserved via the spread —
 * Contacts is never re-consulted. `durationMinutes` is the turn's own
 * EXPLICIT duration (from resolveDurationMinutes on the change clause) or
 * null — null means "not mentioned this turn," which preserves the
 * proposal's EXISTING duration; it never falls back to a stored
 * preference (that lookup only ever happens once, at original creation —
 * see calendar/intent.ts's resolveCreateTiming).
 */
function reviseCalendar(
  rawGoal: string,
  taskId: string,
  onEvent: EventListener,
  clock: { hour: number; minute: number } | null,
  day: { daysFromNow: number; label: string } | null,
  durationMinutes: number | null,
  sessionId: string
): ExecutionResult {
  const action = calendarPendingActionStore.active(sessionId)!;
  const proposal = action.proposal;
  if (proposal.kind === 'delete') {
    return clarifyResult(taskId, rawGoal, "That pending action is a cancellation, not a scheduled time — there's nothing to move.");
  }
  const oldStart = new Date(proposal.start);
  const oldDurationMs = new Date(proposal.end).getTime() - new Date(proposal.start).getTime();
  let hour = oldStart.getHours();
  let minute = oldStart.getMinutes();
  let base = new Date();
  base = day ? new Date(base.getFullYear(), base.getMonth(), base.getDate() + day.daysFromNow) : oldStart;
  if (clock) { hour = clock.hour; minute = clock.minute; }
  const newStartDate = new Date(base.getFullYear(), base.getMonth(), base.getDate(), hour, minute, 0, 0);
  const newStart = newStartDate.toISOString();
  const durationMs = durationMinutes !== null ? durationMinutes * 60000 : oldDurationMs;
  const newEnd = new Date(newStartDate.getTime() + durationMs).toISOString();
  const revised: CalendarProposal = { ...proposal, start: newStart, end: newEnd };
  calendarPendingActionStore.set(sessionId, { type: action.type, proposal: revised, createdAt: Date.now() });

  const resultText =
    `UPDATED EVENT READY FOR CONFIRMATION\n\n` +
    `TITLE: ${revised.title}\n` +
    `DATE: ${formatLocal(newStart, revised.timezone).split(',').slice(0, 2).join(',')}\n` +
    `START: ${formatLocal(newStart, revised.timezone)}\n` +
    `END: ${formatLocal(newEnd, revised.timezone)}\n` +
    `TIMEZONE: ${revised.timezone}\n` +
    `ATTENDEES: ${revised.attendees.length ? revised.attendees.join(', ') : '(none)'}\n` +
    `LOCATION: ${revised.location ?? '(none)'}\n\n` +
    `Say "Create it." to confirm, or make another change.`;
  onEvent({ type: 'agent.completed', timestamp: Date.now(), taskId, data: { result: resultText, capability: 'calendar' } });
  return baseResult(taskId, rawGoal, resultText, {
    calendar: { operation: 'propose_create', pendingAction: { type: action.type, title: revised.title, start: newStart, confirmationRequired: true } },
  });
}

// ============================================================
// Tasks revision
// ============================================================

/** Checkpoint 22/25 — due-date-only revision (Google Tasks has no time-of-day concept — see tasks/types.ts's own note; a clock time is never fabricated here). */
function reviseTasksDue(rawGoal: string, taskId: string, onEvent: EventListener, day: { daysFromNow: number; label: string }, sessionId: string): ExecutionResult {
  const action = tasksPendingActionStore.active(sessionId)!;
  const proposal = action.proposal;
  if (proposal.kind === 'delete' || proposal.kind === 'complete') {
    return clarifyResult(taskId, rawGoal, "That pending action isn't a due-date change — there's nothing to move.");
  }
  const newDue = taskDueIso(day.daysFromNow);
  const revised: TaskProposal = { ...proposal, due: newDue };
  tasksPendingActionStore.set(sessionId, { type: action.type, proposal: revised, createdAt: Date.now() });

  const resultText = `UPDATED TASK READY FOR CONFIRMATION\n\nTASK: ${revised.title}\nDUE DATE: ${formatDueDate(newDue)}\nLIST: (default)\n\nSay "Create it." to confirm, or make another change.`;
  onEvent({ type: 'agent.completed', timestamp: Date.now(), taskId, data: { result: resultText, capability: 'tasks' } });
  return baseResult(taskId, rawGoal, resultText, {
    tasks: { operation: 'propose_create', pendingAction: { type: action.type, title: revised.title, due: revised.due, confirmationRequired: true } },
  });
}

/**
 * Checkpoint 25 — conservative title replacement: only ever reached from
 * attemptProposalRevision's free-text branch, which itself only fires
 * when Tasks is the SOLE capability with something revisable pending (no
 * active Calendar proposal, no active Gmail draft) — see the module
 * comment on why date/time changes are checked first and take priority
 * over treating the same text as a title.
 */
function reviseTasksTitle(rawGoal: string, taskId: string, onEvent: EventListener, newTitleRaw: string, sessionId: string): ExecutionResult {
  const action = tasksPendingActionStore.active(sessionId)!;
  const proposal = action.proposal;
  if (proposal.kind === 'delete' || proposal.kind === 'complete') {
    return clarifyResult(taskId, rawGoal, "That pending action isn't a title change — there's nothing to rename.");
  }
  const cleaned = newTitleRaw.replace(/[.,!?]+$/g, '').trim();
  if (!cleaned) return clarifyResult(taskId, rawGoal, "I didn't catch a new title in that — please say what to change it to.");
  const title = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  const revised: TaskProposal = { ...proposal, title };
  tasksPendingActionStore.set(sessionId, { type: action.type, proposal: revised, createdAt: Date.now() });

  const resultText = `UPDATED TASK READY FOR CONFIRMATION\n\nTASK: ${revised.title}\nDUE DATE: ${revised.due ? formatDueDate(revised.due) : '(none)'}\nLIST: (default)\n\nSay "Create it." to confirm, or make another change.`;
  onEvent({ type: 'agent.completed', timestamp: Date.now(), taskId, data: { result: resultText, capability: 'tasks' } });
  return baseResult(taskId, rawGoal, resultText, {
    tasks: { operation: 'propose_create', pendingAction: { type: action.type, title: revised.title, due: revised.due, confirmationRequired: true } },
  });
}

/** Re-derives clock/day from the STORED change clause (from a now-resolved ambiguity) and applies it to whichever capability the user just named. Never reached for Gmail — a bare day-only change is never ambiguous with Gmail (see attemptProposalRevision's candidate-gating). */
function applyStoredDateRevision(chosen: RevisionCandidate, changeClause: string, rawGoal: string, taskId: string, onEvent: EventListener, sessionId: string): ExecutionResult {
  const clock = resolveClockTime(changeClause) ?? resolveClockTime(`at ${changeClause}`);
  const day = resolveDayPhrase(changeClause);
  const duration = resolveDurationMinutes(changeClause);
  if (chosen === 'calendar') {
    if (!calendarPendingActionStore.active(sessionId)) return clarifyResult(taskId, rawGoal, 'That calendar action is no longer pending — nothing to revise.');
    return reviseCalendar(rawGoal, taskId, onEvent, clock, day, duration, sessionId);
  }
  if (!tasksPendingActionStore.active(sessionId)) return clarifyResult(taskId, rawGoal, 'That task is no longer pending — nothing to revise.');
  if (!day) return clarifyResult(taskId, rawGoal, 'That change did not resolve to a due date — please name a day (e.g. "Friday").');
  return reviseTasksDue(rawGoal, taskId, onEvent, day, sessionId);
}

// ============================================================
// Gmail revision
// ============================================================

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
    return clarifyResult(taskId, rawGoal, "I couldn't find the pending draft's own content to revise — it may have expired.");
  }
  const shortened = shortenText(current.body);
  return applyGmailUpdate(rawGoal, taskId, onEvent, signal, sessionId, action, current, shortened);
}

/**
 * Checkpoint 25 — general body REPLACEMENT (as opposed to the "shorter"
 * truncation heuristic above): the user's own supplied text becomes the
 * new body verbatim, no LLM rewrite, same discipline CP24's
 * extractFollowUpEmailBody already established for the missing-body slot.
 * Recipient and subject are always preserved from the CURRENT draft
 * record — this module deliberately never offers recipient revision (see
 * this file's module comment; substantial new Contacts semantics would be
 * needed to do that safely, so it's out of scope here).
 */
async function reviseGmailBody(rawGoal: string, taskId: string, onEvent: EventListener, signal: AbortSignal | undefined, sessionId: string, newBody: string): Promise<ExecutionResult> {
  const action = pendingActionStore.active(sessionId)!;
  const client = getGmailClient();
  const current = client.getDraft(action.draftId);
  if (!current) {
    return clarifyResult(taskId, rawGoal, "I couldn't find the pending draft's own content to revise — it may have expired.");
  }
  return applyGmailUpdate(rawGoal, taskId, onEvent, signal, sessionId, action, current, newBody);
}

async function applyGmailUpdate(
  rawGoal: string,
  taskId: string,
  onEvent: EventListener,
  signal: AbortSignal | undefined,
  sessionId: string,
  action: { draftId: string; recipient: string[]; subject: string },
  current: { to: string[]; subject: string; cc?: string[] },
  newBody: string
): Promise<ExecutionResult> {
  const client = getGmailClient();
  let updated;
  try {
    updated = await client.updateDraft(action.draftId, current.to, current.subject, newBody, current.cc, signal);
  } catch (e: any) {
    const resultText = `Could not revise the draft: ${e?.message ?? 'unknown error'}`;
    onEvent({ type: 'agent.failed', timestamp: Date.now(), taskId, data: { reason: resultText } });
    return { taskId, goal: rawGoal, status: 'failed', outcome: 'failed', result: resultText, steps: 0, tokensUsed: 0, actions: [], events: [], error: resultText, capability: { selected: 'gmail', reason: 'Draft revision failed.', readAttempted: false, browserFallbackUsed: false } };
  }
  // Same draftId — the pending send action still refers to the SAME real
  // draft object, now revised in place; never a second draft, never sent.
  pendingActionStore.set(sessionId, { type: 'gmail_send', draftId: action.draftId, recipient: action.recipient, subject: action.subject, createdAt: Date.now() });

  const resultText = `DRAFT UPDATED (not sent)\n\nTo: ${updated.to.join(', ')}\nSubject: ${updated.subject}\nBody: ${updated.body}\n\nSay "Send it." to send, or make another change.`;
  onEvent({ type: 'agent.completed', timestamp: Date.now(), taskId, data: { result: resultText, capability: 'gmail' } });
  return baseResult(taskId, rawGoal, resultText, {
    gmail: { operation: 'draft', pendingAction: { type: 'gmail_send', recipient: action.recipient, subject: action.subject, confirmationRequired: true } },
  });
}

// ============================================================
// Entry point
// ============================================================

/**
 * Returns null when `rawGoal` doesn't match a revision shape at all, OR
 * matches the shape but nothing pending exists that it could apply to —
 * both cases fall through to normal routing unchanged. This is also what
 * makes "explicit new commands beat revision" true by construction: a
 * genuinely new command essentially never matches this module's narrow
 * trigger vocabulary (none of "What's in my inbox?", "Create a task to
 * buy milk", "Actually email Priya" start with "make it"/"change it
 * to"/"move it to"/"update it to"/"actually say"), so it falls straight
 * through to the existing capability detectors untouched — no special-
 * casing needed here for that principle beyond keeping the vocabulary
 * narrow, which is also why this module was never widened to a bare
 * standalone "actually X" (see ACTUALLY_SAY_RE's own comment for exactly
 * why that specific word needed narrowing).
 */
export async function attemptProposalRevision(rawGoal: string, providedTaskId: string | undefined, onEvent: EventListener, signal: AbortSignal | undefined, sessionId: string): Promise<ExecutionResult | null> {
  const t = rawGoal.trim();

  // Checkpoint 25 — resolves a "which capability did you mean?" question
  // asked on a PRIOR turn. Only consumes it when the text unambiguously
  // names one of the offered candidates; anything else (including a fresh
  // revision attempt or a genuinely new command) falls through to the
  // checks below with the ambiguity left untouched — never mutates either
  // proposal before this resolves.
  const ambiguity = activeAmbiguity(sessionId);
  if (ambiguity) {
    const chosen = referencedCapability(t);
    if (chosen && ambiguity.candidates.includes(chosen)) {
      clearRevisionAmbiguity(sessionId);
      const taskId = providedTaskId || nanoid();
      return applyStoredDateRevision(chosen, ambiguity.changeClause, rawGoal, taskId, onEvent, sessionId);
    }
  }

  // Checkpoint 25 — standalone "actually say X" (Gmail body only).
  const actuallySay = ACTUALLY_SAY_RE.exec(t);
  if (actuallySay) {
    if (!pendingActionStore.active(sessionId)) return null;
    const taskId = providedTaskId || nanoid();
    return reviseGmailBody(rawGoal, taskId, onEvent, signal, sessionId, actuallySay[1].trim());
  }

  const m = REVISION_LEAD_IN_RE.exec(t);
  if (m) {
    const change = m[1].trim();

    // Gmail body REPLACEMENT — "change it to say X" / "move it to say X" / etc.
    const sayMatch = SAY_RE.exec(change);
    if (sayMatch) {
      if (!pendingActionStore.active(sessionId)) return null;
      const taskId = providedTaskId || nanoid();
      return reviseGmailBody(rawGoal, taskId, onEvent, signal, sessionId, sayMatch[1].trim());
    }

    // Gmail "shorter" truncation heuristic (Checkpoint 22, unchanged).
    if (SHORTER_RE.test(change)) {
      if (!pendingActionStore.active(sessionId)) return null;
      const taskId = providedTaskId || nanoid();
      return reviseGmailShorter(rawGoal, taskId, onEvent, signal, sessionId);
    }

    // Calendar/Tasks date, time, and/or duration.
    const clock = resolveClockTime(change) ?? resolveClockTime(`at ${change}`);
    const day = resolveDayPhrase(change);
    const duration = resolveDurationMinutes(change);
    if (clock || day || duration !== null) {
      const calActive = !!calendarPendingActionStore.active(sessionId);
      const tasksActive = !!tasksPendingActionStore.active(sessionId);
      // A clock-time or duration change only ever applies to Calendar
      // (Tasks has no time-of-day/duration concept — see tasks/types.ts's
      // own due-date-only note). A bare day-only change may ALSO apply to
      // Tasks — the one genuinely ambiguous case.
      const candidates: RevisionCandidate[] = [];
      if (calActive) candidates.push('calendar');
      if (tasksActive && day && !clock && duration === null) candidates.push('tasks');

      if (candidates.length === 0) return null;
      const taskId = providedTaskId || nanoid();
      if (candidates.length > 1) {
        setAmbiguity(sessionId, change, candidates);
        return clarifyResult(taskId, rawGoal, 'I have a pending Calendar action and a pending Tasks action — do you mean the calendar event or the task?');
      }
      return candidates[0] === 'calendar'
        ? reviseCalendar(rawGoal, taskId, onEvent, clock, day, duration, sessionId)
        : reviseTasksDue(rawGoal, taskId, onEvent, day!, sessionId);
    }

    // Free text with no recognized date/time/duration/body signal —
    // conservatively treated as a Tasks TITLE replacement, and ONLY when
    // Tasks is the sole capability with anything revisable pending (no
    // active Calendar proposal, no active Gmail draft) — see
    // reviseTasksTitle's own comment.
    const calActiveForTitle = !!calendarPendingActionStore.active(sessionId);
    const gmailActiveForTitle = !!pendingActionStore.active(sessionId);
    const tasksActiveForTitle = !!tasksPendingActionStore.active(sessionId);
    if (tasksActiveForTitle && !calActiveForTitle && !gmailActiveForTitle) {
      const taskId = providedTaskId || nanoid();
      return reviseTasksTitle(rawGoal, taskId, onEvent, change, sessionId);
    }
    return null;
  }

  return null;
}
