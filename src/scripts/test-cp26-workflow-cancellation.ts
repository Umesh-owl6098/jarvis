/**
 * Checkpoint 26 §Cancellation — workflow-produced pending actions
 * integrate with the EXISTING cancellation architecture (CP21/24)
 * unchanged; no separate workflow cancellation store was created — the
 * capability pending-action stores remain the sole authority.
 */
const TEST_PREFS_PATH = require('os').tmpdir() + '/jarvis-cp26-cancellation-' + Date.now() + '.json';
process.env.JARVIS_PREFERENCES_PATH = TEST_PREFS_PATH;

process.env.USE_MOCK_GMAIL = 'true';
process.env.USE_MOCK_CALENDAR = 'true';
process.env.USE_MOCK_TASKS = 'true';
process.env.USE_MOCK_CONTACTS = 'true';

import { runTask } from '@/core/agent/task-manager';
import { pendingActionStore } from '@/core/capabilities/gmail/pending-action';
import { calendarPendingActionStore } from '@/core/capabilities/calendar/pending-action';
import { tasksPendingActionStore } from '@/core/capabilities/tasks/pending-action';
import { pendingSlotStore } from '@/core/agent/pending-slot';
import { getCalendarClient } from '@/core/capabilities/calendar/resolve';
import { getTasksClient } from '@/core/capabilities/tasks/resolve';
import { nanoid } from 'nanoid';

const SID = 'test-session-a';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

function clearAll(sid: string) {
  pendingActionStore.clear(sid);
  calendarPendingActionStore.clear(sid);
  tasksPendingActionStore.clear(sid);
  pendingSlotStore.clear(sid);
}

async function seedMeetingWithAlice() {
  const client = getCalendarClient();
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 14, 0, 0, 0);
  const end = new Date(start.getTime() + 30 * 60000);
  await client.createEvent({ kind: 'create', title: 'Coffee with Alice', start: start.toISOString(), end: end.toISOString(), timezone: 'UTC', attendees: ['alice@example.com'] });
}
async function runChainWorkflow() {
  return runTask({
    sessionId: SID,
    goal: "Find my meeting with Alice tomorrow, draft her an email saying I'll be there, and remind me to send the notes Friday.",
    onEvent: () => {},
    taskId: nanoid(),
  });
}
async function eventCount(q: string) { return (await getCalendarClient().searchEvents(q, 20)).events.length; }
async function taskCount(q: string) { return (await getTasksClient().searchTasks(q, 20)).tasks.length; }

async function main() {
  clearAll(SID);
  await seedMeetingWithAlice();

  // ---------- 37. Cancel single workflow mutation ----------
  {
    clearAll(SID);
    await runChainWorkflow();
    check('37-setup. workflow produced a real Gmail draft AND a real Tasks proposal', !!pendingActionStore.active(SID) && !!tasksPendingActionStore.active(SID));
    // "Cancel it." with 2 different things pending is genuinely ambiguous
    // — existing multi-pending semantics apply unchanged (see 39 below
    // for "Cancel all"); here we cancel ONE explicitly.
    const r = await runTask({ sessionId: SID, goal: 'Cancel the task.', onEvent: () => {}, taskId: nanoid() });
    check('37. "Cancel the task." cancels the single workflow-produced Task mutation', !tasksPendingActionStore.active(SID) && /task change was not made/i.test(r.result), `result=${r.result}`);
    check('37b. the workflow-produced Gmail draft (untouched by this specific cancellation) remains pending', !!pendingActionStore.active(SID));
    clearAll(SID);
  }

  // ---------- 38. explicit capability cancellation ----------
  {
    clearAll(SID);
    await runChainWorkflow();
    const r = await runTask({ sessionId: SID, goal: 'Cancel the email.', onEvent: () => {}, taskId: nanoid() });
    check('38. "Cancel the email." cancels ONLY the Gmail send-confirmation from the workflow', !pendingActionStore.active(SID) && /draft was not sent/i.test(r.result), `result=${r.result}`);
    check('38b. the workflow-produced Task proposal is untouched', !!tasksPendingActionStore.active(SID));
    clearAll(SID);
  }

  // ---------- 39. "Cancel all" with multiple workflow pending actions ----------
  {
    clearAll(SID);
    await runChainWorkflow();
    check('39-setup. workflow produced BOTH a real Gmail draft and a real Tasks proposal', !!pendingActionStore.active(SID) && !!tasksPendingActionStore.active(SID));
    const r = await runTask({ sessionId: SID, goal: 'Cancel all.', onEvent: () => {}, taskId: nanoid() });
    check('39. "Cancel all." clears BOTH workflow-produced pending mutations at once', !pendingActionStore.active(SID) && !tasksPendingActionStore.active(SID), `result=${r.result}`);
    check('39b. the response names both — never silently drops one', /email draft/i.test(r.result) && /task change/i.test(r.result), `result=${r.result}`);
    clearAll(SID);
  }

  // ---------- 40. no mutation after cancellation ----------
  {
    clearAll(SID);
    const calBefore = await eventCount('Alice');
    const taskBefore = await taskCount('notes');
    await runChainWorkflow();
    await runTask({ sessionId: SID, goal: 'Cancel all.', onEvent: () => {}, taskId: nanoid() });
    const calAfter = await eventCount('Alice');
    const taskAfter = await taskCount('notes');
    check('40. after cancellation, zero real mutations occurred anywhere — no Calendar event, no Task created', calAfter === calBefore && taskAfter === taskBefore, `calBefore=${calBefore} calAfter=${calAfter} taskBefore=${taskBefore} taskAfter=${taskAfter}`);
    check('40b. both pending actions are gone — nothing was left dangling for a later stray confirmation to accidentally execute', !pendingActionStore.active(SID) && !tasksPendingActionStore.active(SID));
    clearAll(SID);
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
