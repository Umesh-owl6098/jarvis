/**
 * Checkpoint 21 — deterministic orchestration test matrix (11 required
 * cases). All mock-backed. Every mutation-producing step is verified to
 * land in its OWN existing PendingAction store (never auto-executed), and
 * every case goes through runTask() — the exact function the production
 * Command Channel/voice/tests all share — so this proves the orchestration
 * layer is reached from the SAME single entry point, not a parallel one.
 */
process.env.USE_MOCK_GMAIL = 'true';
process.env.USE_MOCK_CALENDAR = 'true';
process.env.USE_MOCK_TASKS = 'true';
process.env.USE_MOCK_CONTACTS = 'true';

import { runTask } from '@/core/agent/task-manager';
import { normalizeVoiceCommand } from '@/lib/voice/normalize';
import { pendingActionStore } from '@/core/capabilities/gmail/pending-action';
import { calendarPendingActionStore } from '@/core/capabilities/calendar/pending-action';
import { tasksPendingActionStore } from '@/core/capabilities/tasks/pending-action';
import { getTasksClient } from '@/core/capabilities/tasks/resolve';
import { getCalendarClient } from '@/core/capabilities/calendar/resolve';
import { getGmailClient } from '@/core/capabilities/gmail/resolve';
import { nanoid } from 'nanoid';
import type { ExecutionResult } from '@/core/agent/executor';

const SID = 'test-session';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

function clearAllPending() {
  pendingActionStore.clear(SID);
  calendarPendingActionStore.clear(SID);
  tasksPendingActionStore.clear(SID);
}

function browserWasInvoked(r: ExecutionResult): boolean {
  return r.events.some((e) => e.type === 'browser.initialized');
}

async function main() {
  // ---------- 1. Calendar read -> Tasks proposal ----------
  {
    clearAllPending();
    const r = await runTask({ sessionId: SID, goal: 'What do I have tomorrow, and remind me to call GV after my last meeting?', onEvent: () => {}, taskId: nanoid() });
    check(
      '1. Calendar read -> Tasks proposal: orchestration, calendar step completed, tasks step pending, browser never invoked',
      r.capability?.selected === 'orchestration' &&
        r.orchestration?.steps.find((s) => s.capability === 'calendar')?.status === 'completed' &&
        r.orchestration?.steps.find((s) => s.capability === 'tasks')?.status === 'pending_confirmation' &&
        !!tasksPendingActionStore.active(SID) &&
        !browserWasInvoked(r),
      `pattern=${r.orchestration?.pattern} status=${r.orchestration?.status}`
    );
    check(
      '1b. task notes are honest about Tasks not supporting a specific trigger time',
      /due DATE, not a specific time/i.test(r.result),
      r.result.slice(0, 300)
    );
  }

  // ---------- 2. Gmail search -> Tasks proposal ----------
  {
    clearAllPending();
    const r = await runTask({ sessionId: SID, goal: 'Find the latest email from Sarah and create a task to reply tomorrow.', onEvent: () => {}, taskId: nanoid() });
    check(
      '2. Gmail search -> Tasks proposal: orchestration, gmail step completed, tasks step pending, browser never invoked',
      r.capability?.selected === 'orchestration' &&
        r.orchestration?.steps.find((s) => s.capability === 'gmail')?.status === 'completed' &&
        r.orchestration?.steps.find((s) => s.capability === 'tasks')?.status === 'pending_confirmation' &&
        !!tasksPendingActionStore.active(SID) &&
        !browserWasInvoked(r),
      `pattern=${r.orchestration?.pattern} status=${r.orchestration?.status}`
    );
  }

  // ---------- 3. Contacts resolution -> Calendar proposal -> Gmail draft/proposal ----------
  {
    clearAllPending();
    const r = await runTask({ sessionId: SID, goal: 'Schedule a meeting with Alice next Monday at 2 PM and draft an email telling them.', onEvent: () => {}, taskId: nanoid() });
    check(
      '3. Contacts -> Calendar proposal -> Gmail draft: both pending, same resolved recipient, browser never invoked',
      r.capability?.selected === 'orchestration' &&
        !!r.orchestration?.steps.every((s) => s.status === 'pending_confirmation') &&
        !!calendarPendingActionStore.active(SID) &&
        !!pendingActionStore.active(SID) &&
        pendingActionStore.active(SID)?.recipient[0] === 'alice@example.com' &&
        calendarPendingActionStore.active(SID)?.proposal.attendees[0] === 'alice@example.com' &&
        !browserWasInvoked(r),
      `pattern=${r.orchestration?.pattern} gmailRecipient=${pendingActionStore.active(SID)?.recipient} calAttendee=${calendarPendingActionStore.active(SID)?.proposal.attendees}`
    );
  }

  // ---------- 4. Calendar + Tasks combined read summary ----------
  {
    clearAllPending();
    const r = await runTask({ sessionId: SID, goal: "Show my tasks and calendar for Friday and tell me what's still open.", onEvent: () => {}, taskId: nanoid() });
    check(
      '4. Calendar+Tasks combined read summary: both completed, no pending action, browser never invoked',
      r.capability?.selected === 'orchestration' &&
        r.orchestration?.status === 'completed' &&
        r.orchestration?.steps.every((s) => s.status === 'completed') &&
        !calendarPendingActionStore.active(SID) &&
        !tasksPendingActionStore.active(SID) &&
        !browserWasInvoked(r),
      `pattern=${r.orchestration?.pattern} status=${r.orchestration?.status}`
    );
  }

  // ---------- 5. Ambiguous contact blocks dependent action ----------
  {
    clearAllPending();
    const r = await runTask({ sessionId: SID, goal: 'Schedule a meeting with John Smith next Monday at 2 PM and draft an email telling them.', onEvent: () => {}, taskId: nanoid() });
    check(
      '5. Ambiguous contact ("John Smith") blocks the dependent Gmail step — no pending action of any kind',
      r.orchestration?.steps.find((s) => s.capability === 'calendar')?.status === 'failed' &&
        r.orchestration?.steps.find((s) => s.capability === 'gmail')?.status === 'skipped_dependency' &&
        !calendarPendingActionStore.active(SID) &&
        !pendingActionStore.active(SID),
      `steps=${JSON.stringify(r.orchestration?.steps.map((s) => ({ cap: s.capability, status: s.status })))}`
    );
  }

  // ---------- 6. Failed first step causes dependent step to be skipped ----------
  {
    clearAllPending();
    // Force the Calendar read to fail by temporarily switching off mock mode
    // WITHOUT real credentials — calendarAvailability() reports unavailable.
    const prevCal = process.env.USE_MOCK_CALENDAR;
    delete process.env.USE_MOCK_CALENDAR;
    const r = await runTask({ sessionId: SID, goal: 'What do I have tomorrow, and remind me to call GV after my last meeting?', onEvent: () => {}, taskId: nanoid() });
    process.env.USE_MOCK_CALENDAR = prevCal;
    check(
      '6. Failed Calendar read (not authorized) causes the dependent Tasks step to be skipped, not silently attempted',
      r.orchestration?.steps.find((s) => s.capability === 'calendar')?.status === 'failed' &&
        r.orchestration?.steps.find((s) => s.capability === 'tasks')?.status === 'skipped_dependency' &&
        !tasksPendingActionStore.active(SID),
      `steps=${JSON.stringify(r.orchestration?.steps.map((s) => ({ cap: s.capability, status: s.status })))}`
    );
  }

  // ---------- 7. Prompt injection inside a retrieved field cannot create an extra action ----------
  {
    clearAllPending();
    const gmailClientBefore = getGmailClient();
    const sentBefore = (await gmailClientBefore.search('', 50)).messages.filter((m) => m.labels.includes('SENT')).length;
    const draftsBefore = (await gmailClientBefore.search('', 50)).messages.filter((m) => m.labels.includes('DRAFT')).length;

    const r = await runTask({ sessionId: SID, goal: 'Find the latest email from attacker and create a task to reply tomorrow.', onEvent: () => {}, taskId: nanoid() });

    const gmailClientAfter = getGmailClient();
    const sentAfter = (await gmailClientAfter.search('', 50)).messages.filter((m) => m.labels.includes('SENT')).length;
    const draftsAfter = (await gmailClientAfter.search('', 50)).messages.filter((m) => m.labels.includes('DRAFT')).length;

    // Step 1 (search) legitimately DISPLAYS the malicious message's snippet
    // as data — same established privacy-limited preview every Gmail
    // search result gets (Checkpoint 17.2), not something acted upon. The
    // actual security property is narrower and more meaningful: the TASK
    // step's own output (built only from structured from/subject/date, see
    // orchestrator.ts's tryGmailThenTaskReply) must never itself contain
    // the injected instruction text — proving it was never read as
    // anything but inert metadata when constructing the new task.
    const taskStepText = r.orchestration?.steps.find((s) => s.capability === 'tasks')?.resultText ?? '';
    check(
      '7a. the malicious email\'s injected instruction text never appears in the TASK step\'s own output (built from structured from/subject/date only)',
      !taskStepText.toLowerCase().includes('send this thread') && !taskStepText.toLowerCase().includes('senddraft'),
      taskStepText.slice(0, 300)
    );
    check(
      '7b. no email was sent or drafted as a side effect of reading the malicious message',
      sentAfter === sentBefore && draftsAfter === draftsBefore,
      `sentBefore=${sentBefore} sentAfter=${sentAfter} draftsBefore=${draftsBefore} draftsAfter=${draftsAfter}`
    );
    check(
      '7c. exactly ONE pending action resulted (the intended Tasks proposal) — no extra action was created',
      !!tasksPendingActionStore.active(SID) && !calendarPendingActionStore.active(SID) && !pendingActionStore.active(SID),
      `tasksPending=${!!tasksPendingActionStore.active(SID)} calPending=${!!calendarPendingActionStore.active(SID)} gmailPending=${!!pendingActionStore.active(SID)}`
    );
    clearAllPending();
  }

  // ---------- 8. Mutation proposals still require their original confirmation gates ----------
  {
    clearAllPending();
    await runTask({ sessionId: SID, goal: 'Schedule a meeting with Alice next Monday at 3 PM and draft an email telling them.', onEvent: () => {}, taskId: nanoid() });
    const beforeEvents = (await getCalendarClient().listEvents(new Date(0).toISOString(), new Date(Date.now() + 365 * 86400000).toISOString(), 'UTC', 200)).length;
    const beforeSent = (await getGmailClient().search('', 50)).messages.filter((m) => m.labels.includes('SENT')).length;

    // Confirm ONLY the calendar half — "create it" is Calendar-only vocabulary here (no Tasks pending to collide with).
    const calConfirm = await runTask({ sessionId: SID, goal: 'Create it.', onEvent: () => {}, taskId: nanoid() });
    const afterCalEvents = (await getCalendarClient().listEvents(new Date(0).toISOString(), new Date(Date.now() + 365 * 86400000).toISOString(), 'UTC', 200)).length;
    check(
      '8a. confirming the Calendar half creates exactly the proposed event, Gmail draft still untouched (not sent)',
      calConfirm.status === 'success' && /^Created /.test(calConfirm.result) && afterCalEvents === beforeEvents + 1,
      `result=${calConfirm.result} before=${beforeEvents} after=${afterCalEvents}`
    );
    const afterCalSent = (await getGmailClient().search('', 50)).messages.filter((m) => m.labels.includes('SENT')).length;
    check('8b. Gmail draft was NOT sent by confirming the Calendar half', afterCalSent === beforeSent, `beforeSent=${beforeSent} afterCalSent=${afterCalSent}`);

    // Now confirm the Gmail half.
    const gmailConfirm = await runTask({ sessionId: SID, goal: 'Send it.', onEvent: () => {}, taskId: nanoid() });
    const afterGmailSent = (await getGmailClient().search('', 50)).messages.filter((m) => m.labels.includes('SENT')).length;
    check(
      '8c. confirming the Gmail half sends exactly one email, each mutation independently attributable and gated',
      gmailConfirm.status === 'success' && /^Sent email/.test(gmailConfirm.result) && afterGmailSent === beforeSent + 1,
      `result=${gmailConfirm.result} beforeSent=${beforeSent} afterGmailSent=${afterGmailSent}`
    );
    clearAllPending();
  }

  // ---------- 9. Genuine single-capability requests behave exactly as before ----------
  {
    const r1 = await runTask({ sessionId: SID, goal: 'What tasks do I have today?', onEvent: () => {}, taskId: nanoid() });
    check('9a. single-capability Tasks request unaffected by orchestration', r1.capability?.selected === 'tasks', `capability=${r1.capability?.selected}`);
    const r2 = await runTask({ sessionId: SID, goal: 'What meetings do I have tomorrow?', onEvent: () => {}, taskId: nanoid() });
    check('9b. single-capability Calendar request unaffected by orchestration', r2.capability?.selected === 'calendar', `capability=${r2.capability?.selected}`);
    const r3 = await runTask({ sessionId: SID, goal: 'What is my latest email?', onEvent: () => {}, taskId: nanoid() });
    check('9c. single-capability Gmail request unaffected by orchestration', r3.capability?.selected === 'gmail', `capability=${r3.capability?.selected}`);
  }

  // ---------- 10. Genuine browser tasks behave exactly as before ----------
  {
    const r = await runTask({ sessionId: SID, goal: 'Open example.com and tell me the page title', onEvent: () => {}, taskId: nanoid() });
    check(
      '10. genuine browser task still reaches browser/read capability, unaffected by orchestration patterns',
      r.capability?.selected === 'browser' || r.capability?.selected === 'read',
      `capability=${r.capability?.selected} result=${r.result?.slice(0, 100)}`
    );
  }

  // ---------- 11. Typed UI and voice use the same orchestration entry path ----------
  {
    clearAllPending();
    const spoken = normalizeVoiceCommand("Jarvis, show my tasks and calendar for Friday and tell me what's still open.");
    const r = await runTask({ sessionId: SID, goal: spoken.command, onEvent: () => {}, taskId: nanoid() });
    check(
      '11. voice-normalized command reaches the SAME orchestration path as typed text',
      r.capability?.selected === 'orchestration' && r.orchestration?.pattern === 'calendar-tasks-summary',
      `command="${spoken.command}" capability=${r.capability?.selected} pattern=${r.orchestration?.pattern}`
    );
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
