/**
 * Post-CP23 fix — the "Cancel it." dispatch bug: with a pending TASKS (or
 * GMAIL) proposal and NOTHING pending for Calendar specifically, bare
 * "Cancel it." was unconditionally claimed by Calendar's own top-tier
 * dispatch (unambiguousCalendarPhraseType always maps "cancel it" ->
 * 'calendar_delete', and the old guard fell back to "claim it anyway"
 * whenever nothing calendar-specific was pending) — reporting "no pending
 * calendar action" while the REAL Tasks/Gmail proposal sat there, still
 * armed. Root cause: "cancel it" is shared reject vocabulary, not
 * Calendar-exclusive the way "book it"/"schedule it" is, but only
 * Calendar's own phraseType dictionary happened to include it.
 *
 * Fix (task-manager.ts's calendarPhraseMatchesPending/
 * tasksPhraseMatchesPending): when nothing is pending for THAT specific
 * capability, defer (return null) if the exact phrase is ALSO recognized
 * shared reject vocabulary (isCalendarRejectPhrase/isTasksRejectPhrase/
 * isSendCancelPhrase) AND something else IS pending elsewhere — letting
 * the ambiguous-reject tier's existing activePendingCapabilities()-based
 * disambiguation correctly identify and act on whatever capability
 * actually has something pending. Every other case (a capability with
 * something pending confirming/rejecting its OWN action, or truly nothing
 * pending anywhere) is completely unaffected.
 */
const TEST_PREFS_PATH = require('os').tmpdir() + '/jarvis-post-cp23-cancel-it-' + Date.now() + '.json';
process.env.JARVIS_PREFERENCES_PATH = TEST_PREFS_PATH;

process.env.USE_MOCK_GMAIL = 'true';
process.env.USE_MOCK_CALENDAR = 'true';
process.env.USE_MOCK_TASKS = 'true';
process.env.USE_MOCK_CONTACTS = 'true';

import { runTask } from '@/core/agent/task-manager';
import { calendarPendingActionStore } from '@/core/capabilities/calendar/pending-action';
import { pendingActionStore } from '@/core/capabilities/gmail/pending-action';
import { tasksPendingActionStore } from '@/core/capabilities/tasks/pending-action';
import { getCalendarClient } from '@/core/capabilities/calendar/resolve';
import { getGmailClient } from '@/core/capabilities/gmail/resolve';
import { getTasksClient } from '@/core/capabilities/tasks/resolve';
import { nanoid } from 'nanoid';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

function clearAllPending(sid: string) {
  pendingActionStore.clear(sid);
  calendarPendingActionStore.clear(sid);
  tasksPendingActionStore.clear(sid);
}

async function main() {
  // ---------- 1. Calendar pending create + "Cancel it." -> cleared, zero event created ----------
  {
    const SID = 'sid-1';
    clearAllPending(SID);
    const calClient = getCalendarClient();
    const before = (await calClient.listEvents(new Date(0).toISOString(), new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString(), 'UTC', 200)).length;
    await runTask({ sessionId: SID, goal: 'Schedule a meeting with Alice tomorrow at 9 AM for 30 minutes.', onEvent: () => {}, taskId: nanoid() });
    const r = await runTask({ sessionId: SID, goal: 'Cancel it.', onEvent: () => {}, taskId: nanoid() });
    const after = (await calClient.listEvents(new Date(0).toISOString(), new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString(), 'UTC', 200)).length;
    check(
      '1. Calendar pending create + "Cancel it." -> cleared, zero event created',
      /calendar change was not made/i.test(r.result) && !calendarPendingActionStore.active(SID) && after === before,
      `result=${r.result} before=${before} after=${after}`
    );
  }

  // ---------- 2. Tasks pending create + "Cancel it." -> cleared, zero task created (THE REPORTED BUG) ----------
  {
    const SID = 'sid-2';
    clearAllPending(SID);
    const tasksClient = getTasksClient();
    const before = (await tasksClient.listTasks(tasksClient.defaultListId, 50)).length;
    await runTask({ sessionId: SID, goal: 'Remind me to call Ramesh tomorrow.', onEvent: () => {}, taskId: nanoid() });
    const r = await runTask({ sessionId: SID, goal: 'Cancel it.', onEvent: () => {}, taskId: nanoid() });
    const after = (await tasksClient.listTasks(tasksClient.defaultListId, 50)).length;
    check(
      '2. Tasks pending create + "Cancel it." -> cleared (NOT a "no pending calendar action" message), zero task created',
      /task change was not made/i.test(r.result) && !/calendar/i.test(r.result) && !tasksPendingActionStore.active(SID) && after === before,
      `result=${r.result} before=${before} after=${after}`
    );
  }

  // ---------- 3. Gmail pending send + "Cancel it." -> cleared, zero email sent ----------
  {
    const SID = 'sid-3';
    clearAllPending(SID);
    await runTask({ sessionId: SID, goal: 'Draft an email to isopatch1@example.com saying hello.', onEvent: () => {}, taskId: nanoid() });
    const draftId = pendingActionStore.active(SID)?.draftId;
    const r = await runTask({ sessionId: SID, goal: 'Cancel it.', onEvent: () => {}, taskId: nanoid() });
    const client = getGmailClient();
    const draftAfter = draftId ? client.getDraft(draftId) : null;
    check(
      '3. Gmail pending send + "Cancel it." -> cleared, zero email sent',
      /draft was not sent/i.test(r.result) && !pendingActionStore.active(SID) && draftAfter?.sent === false,
      `result=${r.result} sent=${draftAfter?.sent}`
    );
  }

  // ---------- 4. Calendar + Gmail pending simultaneously + "Cancel it." -> clarification, neither cleared ----------
  {
    const SID = 'sid-4';
    clearAllPending(SID);
    await runTask({ sessionId: SID, goal: 'Schedule a meeting with Alice tomorrow at 10 AM for 30 minutes.', onEvent: () => {}, taskId: nanoid() });
    await runTask({ sessionId: SID, goal: 'Draft an email to isopatch2@example.com saying hi.', onEvent: () => {}, taskId: nanoid() });
    const r = await runTask({ sessionId: SID, goal: 'Cancel it.', onEvent: () => {}, taskId: nanoid() });
    check(
      '4. Calendar + Gmail pending simultaneously + "Cancel it." -> clarification, neither cleared',
      /which should i cancel/i.test(r.result) && !!calendarPendingActionStore.active(SID) && !!pendingActionStore.active(SID),
      `result=${r.result}`
    );
    clearAllPending(SID);
  }

  // ---------- 5. Calendar + Tasks pending simultaneously + "Cancel it." -> clarification, neither cleared ----------
  {
    const SID = 'sid-5';
    clearAllPending(SID);
    await runTask({ sessionId: SID, goal: 'Schedule a meeting with Alice tomorrow at 11 AM for 30 minutes.', onEvent: () => {}, taskId: nanoid() });
    await runTask({ sessionId: SID, goal: 'Remind me to submit the report tomorrow.', onEvent: () => {}, taskId: nanoid() });
    const r = await runTask({ sessionId: SID, goal: 'Cancel it.', onEvent: () => {}, taskId: nanoid() });
    check(
      '5. Calendar + Tasks pending simultaneously + "Cancel it." -> clarification, neither cleared',
      /which should i cancel/i.test(r.result) && !!calendarPendingActionStore.active(SID) && !!tasksPendingActionStore.active(SID),
      `result=${r.result}`
    );
    clearAllPending(SID);
  }

  // ---------- 6. "Cancel the task" only clears Tasks ----------
  {
    const SID = 'sid-6';
    clearAllPending(SID);
    await runTask({ sessionId: SID, goal: 'Schedule a meeting with Alice tomorrow at 1 PM for 30 minutes.', onEvent: () => {}, taskId: nanoid() });
    await runTask({ sessionId: SID, goal: 'Remind me to call Ramesh tomorrow.', onEvent: () => {}, taskId: nanoid() });
    const r = await runTask({ sessionId: SID, goal: 'Cancel the task', onEvent: () => {}, taskId: nanoid() });
    check(
      '6. "Cancel the task" only clears Tasks, leaves Calendar untouched',
      /task change was not made/i.test(r.result) && !tasksPendingActionStore.active(SID) && !!calendarPendingActionStore.active(SID),
      `result=${r.result}`
    );
    clearAllPending(SID);
  }

  // ---------- 7. "Cancel the meeting" only clears Calendar ----------
  {
    const SID = 'sid-7';
    clearAllPending(SID);
    await runTask({ sessionId: SID, goal: 'Schedule a meeting with Alice tomorrow at 2 PM for 30 minutes.', onEvent: () => {}, taskId: nanoid() });
    await runTask({ sessionId: SID, goal: 'Remind me to call Ramesh tomorrow.', onEvent: () => {}, taskId: nanoid() });
    const r = await runTask({ sessionId: SID, goal: 'Cancel the meeting', onEvent: () => {}, taskId: nanoid() });
    check(
      '7. "Cancel the meeting" only clears Calendar, leaves Tasks untouched',
      /calendar change was not made/i.test(r.result) && !calendarPendingActionStore.active(SID) && !!tasksPendingActionStore.active(SID),
      `result=${r.result}`
    );
    clearAllPending(SID);
  }

  // ---------- 8. "Cancel the email" only clears Gmail ----------
  {
    const SID = 'sid-8';
    clearAllPending(SID);
    await runTask({ sessionId: SID, goal: 'Schedule a meeting with Alice tomorrow at 3 PM for 30 minutes.', onEvent: () => {}, taskId: nanoid() });
    await runTask({ sessionId: SID, goal: 'Draft an email to isopatch3@example.com saying hey.', onEvent: () => {}, taskId: nanoid() });
    const r = await runTask({ sessionId: SID, goal: 'Cancel the email', onEvent: () => {}, taskId: nanoid() });
    check(
      '8. "Cancel the email" only clears Gmail, leaves Calendar untouched',
      /draft was not sent/i.test(r.result) && !pendingActionStore.active(SID) && !!calendarPendingActionStore.active(SID),
      `result=${r.result}`
    );
    clearAllPending(SID);
  }

  // ---------- 9. "Cancel all" / "Cancel both" preserve existing multi-pending semantics ----------
  {
    const SID = 'sid-9a';
    clearAllPending(SID);
    await runTask({ sessionId: SID, goal: 'Schedule a meeting with Alice tomorrow at 4 PM for 30 minutes.', onEvent: () => {}, taskId: nanoid() });
    await runTask({ sessionId: SID, goal: 'Draft an email to isopatch4@example.com saying yo.', onEvent: () => {}, taskId: nanoid() });
    const r = await runTask({ sessionId: SID, goal: 'Cancel all.', onEvent: () => {}, taskId: nanoid() });
    check(
      '9a. "Cancel all." clears both Calendar and Gmail',
      r.status === 'success' && !calendarPendingActionStore.active(SID) && !pendingActionStore.active(SID),
      `result=${r.result}`
    );
    clearAllPending(SID);
  }
  {
    const SID = 'sid-9b';
    clearAllPending(SID);
    await runTask({ sessionId: SID, goal: 'Schedule a meeting with Alice tomorrow at 5 PM for 30 minutes.', onEvent: () => {}, taskId: nanoid() });
    await runTask({ sessionId: SID, goal: 'Remind me to submit the report tomorrow.', onEvent: () => {}, taskId: nanoid() });
    const r = await runTask({ sessionId: SID, goal: 'Cancel both.', onEvent: () => {}, taskId: nanoid() });
    check(
      '9b. "Cancel both." clears both Calendar and Tasks',
      r.status === 'success' && !calendarPendingActionStore.active(SID) && !tasksPendingActionStore.active(SID),
      `result=${r.result}`
    );
    clearAllPending(SID);
  }

  // ---------- 10. Session isolation: Session A "Cancel it." cannot clear Session B's only pending action ----------
  {
    const SIDA = 'sid-10a';
    const SIDB = 'sid-10b';
    clearAllPending(SIDA);
    clearAllPending(SIDB);
    await runTask({ sessionId: SIDA, goal: 'Remind me to call Ramesh tomorrow.', onEvent: () => {}, taskId: nanoid() });
    const r = await runTask({ sessionId: SIDB, goal: 'Cancel it.', onEvent: () => {}, taskId: nanoid() });
    check(
      '10. session B\'s "Cancel it." (nothing pending for B) never touches session A\'s pending Tasks proposal',
      !!tasksPendingActionStore.active(SIDA),
      `result=${r.result} sessionA still active=${!!tasksPendingActionStore.active(SIDA)}`
    );
    clearAllPending(SIDA);
    clearAllPending(SIDB);
  }

  // ---------- Critical regression preserved: pending calendar_create + "Cancel it." must NEVER create the event ----------
  {
    const SID = 'sid-critical';
    clearAllPending(SID);
    const calClient = getCalendarClient();
    const before = (await calClient.listEvents(new Date(0).toISOString(), new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString(), 'UTC', 200)).length;
    await runTask({ sessionId: SID, goal: 'Schedule a meeting with Alice tomorrow at 7 PM for 30 minutes.', onEvent: () => {}, taskId: nanoid() });
    const r = await runTask({ sessionId: SID, goal: 'Cancel it.', onEvent: () => {}, taskId: nanoid() });
    const after = (await calClient.listEvents(new Date(0).toISOString(), new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString(), 'UTC', 200)).length;
    check(
      'CRITICAL. pending calendar_create + "Cancel it." never creates the event (the original CP22 bug, still fixed)',
      after === before && !/EVENT READY FOR CONFIRMATION/.test(r.result),
      `before=${before} after=${after} result=${r.result}`
    );
    clearAllPending(SID);
  }

  // ---------- Critical regression preserved: pending calendar_delete + "Cancel it." must still CONFIRM the deletion ----------
  {
    const SID = 'sid-delete-confirm';
    clearAllPending(SID);
    const calClient = getCalendarClient();
    const before = await calClient.searchEvents('Quarterly', 5);
    const propose = await runTask({ sessionId: SID, goal: 'Cancel my Quarterly Planning meeting.', onEvent: () => {}, taskId: nanoid() });
    const r = await runTask({ sessionId: SID, goal: 'Cancel it.', onEvent: () => {}, taskId: nanoid() });
    const after = await calClient.searchEvents('Quarterly', 5);
    check(
      'CRITICAL. pending calendar_delete + "Cancel it." still CONFIRMS the deletion (unrelated existing behavior, unaffected by this fix)',
      /EVENT CANCELLATION READY FOR CONFIRMATION/.test(propose.result) && before.events.length === 1 && after.events.length === 0 && /Cancelled "Quarterly/i.test(r.result),
      `propose=${propose.result.slice(0, 60)} before=${before.events.length} after=${after.events.length} confirmResult=${r.result}`
    );
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  try { require('fs').rmSync(TEST_PREFS_PATH, { force: true }); } catch {}
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error('Fatal error:', e);
  try { require('fs').rmSync(TEST_PREFS_PATH, { force: true }); } catch {}
  process.exit(1);
});
