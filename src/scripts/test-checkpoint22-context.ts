/**
 * Checkpoint 22 — deterministic conversational-context test matrix (16
 * required cases). All mock-backed, all through runTask() — the exact
 * function the production Command Channel/voice/orchestration share.
 */
process.env.USE_MOCK_GMAIL = 'true';
process.env.USE_MOCK_CALENDAR = 'true';
process.env.USE_MOCK_TASKS = 'true';
process.env.USE_MOCK_CONTACTS = 'true';

import { runTask } from '@/core/agent/task-manager';
import { normalizeVoiceCommand } from '@/lib/voice/normalize';
import { conversationContext } from '@/core/agent/conversation-context';
import { pendingActionStore } from '@/core/capabilities/gmail/pending-action';
import { calendarPendingActionStore } from '@/core/capabilities/calendar/pending-action';
import { tasksPendingActionStore } from '@/core/capabilities/tasks/pending-action';
import { getGmailClient } from '@/core/capabilities/gmail/resolve';
import { getCalendarClient } from '@/core/capabilities/calendar/resolve';
import { getTasksClient } from '@/core/capabilities/tasks/resolve';
import { nanoid } from 'nanoid';
import type { ExecutionResult } from '@/core/agent/executor';

const SID = 'test-session';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

// Test-determinism fix — a weekday name guaranteed to resolve (via
// calendar/datetime.ts's own resolveDayPhrase/daysUntilWeekday) to a date
// distinct from the pending proposal's EXISTING "tomorrow" due date,
// regardless of which real weekday it is. Fixes a latent collision: a
// hardcoded "Friday" happens to equal "tomorrow" whenever today is
// Thursday, which made a revision assertion expecting the due date to
// CHANGE fail on Thursdays specifically. Derived from the ACTUAL due value
// the pending proposal already has (never from the test process's own
// independent `new Date().getDay()` read) — production "tomorrow"/
// weekday-name semantics are completely unchanged.
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * Timezone-safe weekday (0=Sunday..6=Saturday) for a Google Tasks
 * date-only `due` value. Mirrors tasks/datetime.ts's own formatDueDate()
 * parsing technique — slice the Y-M-D substring, construct a LOCAL Date
 * from those exact numbers — rather than `new Date(due).getDay()`, which
 * parses `due` as a UTC instant first and then converts to the process's
 * local time before reading the weekday; in a negative UTC-offset
 * timezone that conversion can silently shift the calendar day backward,
 * returning the wrong weekday.
 */
function dateOnlyWeekday(due: string): number {
  const [y, m, d] = due.slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d).getDay();
}

/**
 * Derives a replacement weekday from the ACTUAL existing due date (offset
 * +3 from its weekday). For a `due` that is always "tomorrow" (as every
 * caller here sets up), this always resolves to exactly 4 days from
 * today — provably distinct from "tomorrow" (1 day) for all 7 possible
 * weekdays, never just Thursday (see the CP27 final report's exhaustive
 * 7-case proof).
 */
function distinctRevisionWeekdayFromDue(dueIso: string): { name: string; weekday: number } {
  const weekday = (dateOnlyWeekday(dueIso) + 3) % 7;
  return { name: WEEKDAY_NAMES[weekday], weekday };
}

function clearAll() {
  pendingActionStore.clear(SID);
  calendarPendingActionStore.clear(SID);
  tasksPendingActionStore.clear(SID);
  conversationContext.clear(SID);
}

function browserWasInvoked(r: ExecutionResult): boolean {
  return r.events.some((e) => e.type === 'browser.initialized');
}

async function main() {
  // ---------- 1. Calendar date follow-up ----------
  {
    clearAll();
    const r1 = await runTask({ sessionId: SID, goal: 'What meetings do I have tomorrow?', onEvent: () => {}, taskId: nanoid() });
    check('1a. base calendar query completes', r1.capability?.selected === 'calendar');
    const r2 = await runTask({ sessionId: SID, goal: 'What about Friday?', onEvent: () => {}, taskId: nanoid() });
    check(
      '1b. "What about Friday?" resolves via context to a Calendar query for Friday, not browser',
      r2.capability?.selected === 'calendar' && !browserWasInvoked(r2),
      `capability=${r2.capability?.selected} result=${r2.result.slice(0, 100)}`
    );
  }

  // ---------- 2. Tasks date follow-up (relative "the day after") ----------
  {
    clearAll();
    const r1 = await runTask({ sessionId: SID, goal: 'What tasks do I have tomorrow?', onEvent: () => {}, taskId: nanoid() });
    check('2a. base tasks query completes', r1.capability?.selected === 'tasks');
    const r2 = await runTask({ sessionId: SID, goal: 'What about the day after?', onEvent: () => {}, taskId: nanoid() });
    check(
      '2b. "What about the day after?" resolves relative to the PRIOR date (tomorrow+1), stays on Tasks',
      r2.capability?.selected === 'tasks' && !browserWasInvoked(r2),
      `capability=${r2.capability?.selected} result=${r2.result.slice(0, 100)}`
    );
  }

  // ---------- 3. Pending Calendar proposal revision ----------
  {
    clearAll();
    const client = getCalendarClient();
    const before = (await client.listEvents(new Date().toISOString(), new Date(Date.now() + 30 * 86400000).toISOString(), 'UTC', 100)).length;
    await runTask({ sessionId: SID, goal: 'Schedule a meeting with Alice tomorrow at 2 PM.', onEvent: () => {}, taskId: nanoid() });
    const oldStart = calendarPendingActionStore.active(SID)?.proposal.start;
    const r = await runTask({ sessionId: SID, goal: 'Make that 3 PM.', onEvent: () => {}, taskId: nanoid() });
    const newStart = calendarPendingActionStore.active(SID)?.proposal.start;
    const after = (await client.listEvents(new Date().toISOString(), new Date(Date.now() + 30 * 86400000).toISOString(), 'UTC', 100)).length;
    check(
      '3. "Make that 3 PM" revises the SAME pending proposal (not a second one), still unconfirmed, no event created',
      r.status === 'success' && newStart !== oldStart && new Date(newStart!).getUTCHours() !== new Date(oldStart!).getUTCHours() &&
        !!calendarPendingActionStore.active(SID) && after === before,
      `oldStart=${oldStart} newStart=${newStart} before=${before} after=${after}`
    );
    clearAll();
  }

  // ---------- 4. Pending Task proposal revision ----------
  {
    clearAll();
    const client = getTasksClient();
    await runTask({ sessionId: SID, goal: 'Remind me to submit the report tomorrow.', onEvent: () => {}, taskId: nanoid() });
    const oldDue = tasksPendingActionStore.active(SID)?.proposal.due;
    const revisionWeekday = distinctRevisionWeekdayFromDue(oldDue!);
    const r = await runTask({ sessionId: SID, goal: `Make that ${revisionWeekday.name}.`, onEvent: () => {}, taskId: nanoid() });
    const newDue = tasksPendingActionStore.active(SID)?.proposal.due;
    const allTasks = await client.listTasks(client.defaultListId, 100);
    const createdNow = allTasks.some((tk) => tk.title.toLowerCase().includes('submit') && tk.due === newDue);
    check(
      '4. "Make that Friday" revises the pending Tasks proposal, no real task created',
      r.status === 'success' && newDue !== oldDue && !!tasksPendingActionStore.active(SID) && !createdNow,
      `oldDue=${oldDue} newDue=${newDue}`
    );
    clearAll();
  }

  // ---------- 5. Gmail draft revision (shorter), never sent ----------
  {
    clearAll();
    await runTask({ sessionId: SID, goal: 'Draft an email to Alice saying I wanted to reach out and let you know that I will call you tomorrow to discuss the project timeline in detail.', onEvent: () => {}, taskId: nanoid() });
    const draftId = pendingActionStore.active(SID)?.draftId;
    const before = getGmailClient().getDraft(draftId!);
    const r = await runTask({ sessionId: SID, goal: 'Make it shorter.', onEvent: () => {}, taskId: nanoid() });
    const after = getGmailClient().getDraft(draftId!);
    check(
      '5. "Make it shorter" revises the SAME draft in place (shorter body, same draftId), never sent',
      r.status === 'success' && after!.body.length < before!.body.length && after!.draftId === before!.draftId && after!.sent === false,
      `beforeLen=${before?.body.length} afterLen=${after?.body.length} sent=${after?.sent}`
    );
    clearAll();
  }

  // ---------- 6. Pronoun resolution — known single contact ----------
  {
    clearAll();
    await runTask({ sessionId: SID, goal: 'Schedule a meeting with Alice tomorrow at 4 PM.', onEvent: () => {}, taskId: nanoid() });
    const r = await runTask({ sessionId: SID, goal: 'Draft an email to them about the meeting.', onEvent: () => {}, taskId: nanoid() });
    check(
      '6. "them" resolves to the previously-resolved single contact (Alice)',
      r.capability?.selected === 'gmail' && /alice@example\.com/.test(r.result) && /DRAFT CREATED/.test(r.result),
      `capability=${r.capability?.selected} result=${r.result.slice(0, 150)}`
    );
    clearAll();
  }

  // ---------- 7. Ambiguous pronoun — clarification, no mutation ----------
  {
    clearAll();
    await runTask({ sessionId: SID, goal: 'Schedule a meeting with John Smith tomorrow at 5 PM.', onEvent: () => {}, taskId: nanoid() });
    const r = await runTask({ sessionId: SID, goal: 'Draft an email to them saying hello.', onEvent: () => {}, taskId: nanoid() });
    check(
      '7. ambiguous prior contact -> "them" asks for clarification, no draft, no pending action',
      r.outcome === 'blocked' && /multiple contacts/i.test(r.result) && !pendingActionStore.active(SID),
      `outcome=${r.outcome} result=${r.result} gmailPending=${!!pendingActionStore.active(SID)}`
    );
    clearAll();
  }

  // ---------- 8. Multi-pending: "Cancel the email" clears only Gmail ----------
  {
    clearAll();
    await runTask({ sessionId: SID, goal: 'Schedule a meeting with Alice tomorrow at 6 PM and draft an email telling them.', onEvent: () => {}, taskId: nanoid() });
    const before = { cal: !!calendarPendingActionStore.active(SID), gmail: !!pendingActionStore.active(SID) };
    const r = await runTask({ sessionId: SID, goal: 'Cancel the email.', onEvent: () => {}, taskId: nanoid() });
    check(
      '8. "Cancel the email." clears ONLY Gmail, Calendar proposal untouched',
      before.cal && before.gmail && !pendingActionStore.active(SID) && !!calendarPendingActionStore.active(SID) && /draft was not sent/i.test(r.result),
      `result=${r.result}`
    );
    clearAll();
  }

  // ---------- 9. Multi-pending: bare "Cancel it" -> clarification, clears neither ----------
  {
    clearAll();
    await runTask({ sessionId: SID, goal: 'Schedule a meeting with Alice tomorrow at 7 PM and draft an email telling them.', onEvent: () => {}, taskId: nanoid() });
    const r = await runTask({ sessionId: SID, goal: 'Cancel it.', onEvent: () => {}, taskId: nanoid() });
    check(
      '9. bare "Cancel it" with 2 pendings asks which, clears NEITHER (also proves the calendar_create/calendar_delete phrase-type-mismatch fix)',
      /which should i cancel/i.test(r.result) && !!calendarPendingActionStore.active(SID) && !!pendingActionStore.active(SID),
      `result=${r.result}`
    );
    clearAll();
  }

  // ---------- 10. "Start over" clears context, not remote data ----------
  {
    clearAll();
    await runTask({ sessionId: SID, goal: 'What meetings do I have tomorrow?', onEvent: () => {}, taskId: nanoid() });
    check('10a. context populated after a real query', !!conversationContext.latest(SID));
    const r = await runTask({ sessionId: SID, goal: 'Start over.', onEvent: () => {}, taskId: nanoid() });
    check('10b. "Start over" clears conversational context', !conversationContext.latest(SID) && /cleared conversational context/i.test(r.result));
    const follow = await runTask({ sessionId: SID, goal: 'What about Friday?', onEvent: () => {}, taskId: nanoid() });
    check(
      '10c. a follow-up right after reset cannot silently resolve — asks for the full question instead',
      follow.outcome === 'blocked' && /prior calendar or task question/i.test(follow.result),
      `result=${follow.result}`
    );
  }

  // ---------- 11. Expired context: old that/it/them cannot resolve silently ----------
  {
    clearAll();
    // Inject an already-expired turn directly (11+ minutes old > 10-minute TTL) — see conversation-context.ts's test-only hook.
    conversationContext.__pushForTesting(SID, {
      capability: 'calendar', operation: 'list', dateRef: { daysFromNow: 1, label: 'tomorrow' }, createdAt: Date.now() - 11 * 60 * 1000,
    });
    const r = await runTask({ sessionId: SID, goal: 'What about Friday?', onEvent: () => {}, taskId: nanoid() });
    check(
      '11. an expired context turn cannot resolve a follow-up silently — treated as if no context existed',
      r.outcome === 'blocked' && /prior calendar or task question/i.test(r.result),
      `result=${r.result}`
    );
    clearAll();
  }

  // ---------- 12. Prompt-injected email content cannot become follow-up instructions ----------
  {
    clearAll();
    // The mock fixture message from attacker@evil.example has body text
    // that is itself a direct instruction-injection attempt. Reading it
    // must never populate context in a way a later "them"/date follow-up
    // could act on, and must never itself get treated as a new command.
    const r1 = await runTask({ sessionId: SID, goal: 'Find the latest email from attacker.', onEvent: () => {}, taskId: nanoid() });
    check('12a. reading the malicious message completes normally', r1.status === 'success');
    const ctx = conversationContext.latest(SID);
    check(
      '12b. context after reading it carries no contact/date reference derived from the injected body text',
      !ctx?.contactRef && !ctx?.dateRef,
      `ctx=${JSON.stringify(ctx)}`
    );
    const r2 = await runTask({ sessionId: SID, goal: 'Draft an email to them saying hi.', onEvent: () => {}, taskId: nanoid() });
    check(
      '12c. "them" does not resolve to anything from the injected content — no draft created',
      r2.capability?.selected !== 'gmail' || !/DRAFT CREATED/.test(r2.result) || !pendingActionStore.active(SID),
      `capability=${r2.capability?.selected} result=${r2.result.slice(0, 150)} gmailPending=${!!pendingActionStore.active(SID)}`
    );
    clearAll();
  }

  // ---------- 13. Existing single-turn behavior unchanged ----------
  {
    clearAll();
    const r1 = await runTask({ sessionId: SID, goal: 'What tasks do I have today?', onEvent: () => {}, taskId: nanoid() });
    check('13a. single-turn Tasks unaffected', r1.capability?.selected === 'tasks');
    const r2 = await runTask({ sessionId: SID, goal: 'What meetings do I have tomorrow?', onEvent: () => {}, taskId: nanoid() });
    check('13b. single-turn Calendar unaffected', r2.capability?.selected === 'calendar');
    const r3 = await runTask({ sessionId: SID, goal: 'What is my latest email?', onEvent: () => {}, taskId: nanoid() });
    check('13c. single-turn Gmail unaffected', r3.capability?.selected === 'gmail');
  }

  // ---------- 14. Existing CP21 compound orchestration unchanged ----------
  {
    clearAll();
    const r = await runTask({ sessionId: SID, goal: 'What meetings and tasks do I have today?', onEvent: () => {}, taskId: nanoid() });
    check(
      '14. CP21 compound orchestration (Calendar+Tasks) still works unchanged',
      r.capability?.selected === 'orchestration' && r.orchestration?.pattern === 'calendar-tasks-summary',
      `pattern=${r.orchestration?.pattern}`
    );
    clearAll();
  }

  // ---------- 15. Browser commands unchanged ----------
  {
    const r = await runTask({ sessionId: SID, goal: 'Open example.com and tell me the page title', onEvent: () => {}, taskId: nanoid() });
    check(
      '15. genuine browser task still reaches browser/read capability',
      r.capability?.selected === 'browser' || r.capability?.selected === 'read',
      `capability=${r.capability?.selected}`
    );
  }

  // ---------- 16. Typed and voice share the identical context-resolution path ----------
  {
    clearAll();
    await runTask({ sessionId: SID, goal: 'What meetings do I have tomorrow?', onEvent: () => {}, taskId: nanoid() });
    const spoken = normalizeVoiceCommand('Jarvis, what about Friday?');
    const r = await runTask({ sessionId: SID, goal: spoken.command, onEvent: () => {}, taskId: nanoid() });
    check(
      '16. voice-normalized follow-up resolves through the SAME context path as typed text',
      r.capability?.selected === 'calendar' && !browserWasInvoked(r),
      `command="${spoken.command}" capability=${r.capability?.selected}`
    );
    clearAll();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
