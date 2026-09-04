/**
 * Checkpoint 29 §Regression/§Session — CP26 workflows, CP27 briefing, and
 * CP28 attention all still route unchanged; direct Gmail/Calendar/Tasks
 * reads are unaffected; reminders survive a new UI session (a fresh
 * sessionId) while pending CONFIRMATION state stays session-isolated —
 * the reminder itself is intentionally global local-user state, not
 * session-scoped, unlike CP22 context/CP24 slots/every PendingAction store.
 */
const TEST_REMINDERS_PATH = require('os').tmpdir() + '/jarvis-cp29-regression-' + Date.now() + '.json';
process.env.JARVIS_REMINDERS_PATH = TEST_REMINDERS_PATH;
const TEST_PREFS_PATH = require('os').tmpdir() + '/jarvis-cp29-regression-prefs-' + Date.now() + '.json';
process.env.JARVIS_PREFERENCES_PATH = TEST_PREFS_PATH;

process.env.USE_MOCK_GMAIL = 'true';
process.env.USE_MOCK_CALENDAR = 'true';
process.env.USE_MOCK_TASKS = 'true';
process.env.USE_MOCK_CONTACTS = 'true';

import { runTask } from '@/core/agent/task-manager';
import { reminderStore } from '@/core/reminders/store';
import { reminderPendingActionStore } from '@/core/reminders/pending-action';
import { pendingActionStore } from '@/core/capabilities/gmail/pending-action';
import { calendarPendingActionStore } from '@/core/capabilities/calendar/pending-action';
import { tasksPendingActionStore } from '@/core/capabilities/tasks/pending-action';
import { nanoid } from 'nanoid';

const SID = 'test-session-a';
const SID_B = 'test-session-b';

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
  reminderPendingActionStore.clear(sid);
}

async function main() {
  clearAll(SID);
  clearAll(SID_B);

  // ---------- 1. CP28 attention still routes unchanged ----------
  {
    const r = await runTask({ sessionId: SID, goal: 'Anything urgent?', onEvent: () => {}, taskId: nanoid() });
    check('1. "Anything urgent?" still routes to attention, unaffected by CP29', r.capability?.selected === 'attention', `capability=${r.capability?.selected}`);
    clearAll(SID);
  }

  // ---------- 2. CP27 briefing still routes unchanged ----------
  {
    const r = await runTask({ sessionId: SID, goal: 'Brief me on my day.', onEvent: () => {}, taskId: nanoid() });
    check('2. "Brief me on my day." still routes to briefing, unaffected by CP29', r.capability?.selected === 'briefing', `capability=${r.capability?.selected}`);
    clearAll(SID);
  }

  // ---------- 3. CP26 workflows still route unchanged ----------
  {
    const r = await runTask({ sessionId: SID, goal: 'Find my last meeting tomorrow and remind me to send notes afterward.', onEvent: () => {}, taskId: nanoid() });
    check('3. a genuine CP26 workflow phrase still routes to orchestration, unaffected by CP29', r.capability?.selected === 'orchestration', `capability=${r.capability?.selected} pattern=${(r as any).orchestration?.pattern}`);
    clearAll(SID);
  }

  // ---------- 4. direct Calendar/Tasks/Gmail reads unchanged ----------
  {
    const r = await runTask({ sessionId: SID, goal: 'What meetings do I have tomorrow?', onEvent: () => {}, taskId: nanoid() });
    check('4a. an explicit Calendar read still routes to calendar', r.capability?.selected === 'calendar', `capability=${r.capability?.selected}`);
    clearAll(SID);
  }
  {
    const r = await runTask({ sessionId: SID, goal: 'What tasks do I have today?', onEvent: () => {}, taskId: nanoid() });
    check('4b. an explicit Tasks read still routes to tasks', r.capability?.selected === 'tasks', `capability=${r.capability?.selected}`);
    clearAll(SID);
  }
  {
    const r = await runTask({ sessionId: SID, goal: 'Show me my recent emails.', onEvent: () => {}, taskId: nanoid() });
    check('4c. an explicit Gmail read still routes to gmail', r.capability?.selected === 'gmail', `capability=${r.capability?.selected}`);
    clearAll(SID);
  }
  {
    // Tasks' own pre-CP29 "remind me to X" (no time) creation trigger, fully unaffected.
    const r = await runTask({ sessionId: SID, goal: 'Remind me to call GV.', onEvent: () => {}, taskId: nanoid() });
    check('4d. Tasks\' own bare "remind me to X" (no time) still creates a TASK proposal, unaffected by CP29', r.capability?.selected === 'tasks', `capability=${r.capability?.selected}`);
    clearAll(SID);
  }

  // ---------- 5. reminders survive a new UI session (a fresh sessionId, simulating a page reload) ----------
  {
    clearAll(SID);
    await runTask({ sessionId: SID, goal: 'Remind me in 20 minutes to check the mailbox.', onEvent: () => {}, taskId: nanoid() });
    await runTask({ sessionId: SID, goal: 'Confirm', onEvent: () => {}, taskId: nanoid() });
    check('5-setup. the reminder is persisted under session A', reminderStore.scheduledSorted().some((r) => r.text === 'check the mailbox'));

    // A brand-new session id — simulates a page reload, which mints a
    // fresh crypto.randomUUID() per page.tsx's own documented behavior.
    const SID_RELOAD = 'test-session-reload-' + nanoid();
    const r = await runTask({ sessionId: SID_RELOAD, goal: 'What reminders do I have?', onEvent: () => {}, taskId: nanoid() });
    check('5. the reminder is visible from a COMPLETELY DIFFERENT session id — the persisted reminder is intentionally global local-user state, not session-scoped', r.result.includes('check the mailbox'), `result=${r.result}`);
    clearAll(SID);
    clearAll(SID_RELOAD);
    const cleanup = reminderStore.scheduledSorted().find((x) => x.text === 'check the mailbox');
    if (cleanup) reminderStore.cancel(cleanup.id);
  }

  // ---------- 6. pending CONFIRMATION state remains fully session-isolated (unlike the reminder itself once created) ----------
  {
    clearAll(SID);
    clearAll(SID_B);
    await runTask({ sessionId: SID, goal: 'Remind me in 20 minutes to check the mailbox again.', onEvent: () => {}, taskId: nanoid() });
    check('6-setup. session A has an active reminder pending action', !!reminderPendingActionStore.active(SID));
    check('6. session B has NO pending reminder action — proposing in A never leaks into B', !reminderPendingActionStore.active(SID_B));

    // Bare "Confirm" with NOTHING pending in session B falls through to
    // generic (real, non-mocked) browser/OmniRoute routing — aborted
    // quickly once real routing genuinely starts, same bounded technique
    // used throughout this suite, since this test is only about session
    // isolation, not browser behavior.
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 150);
    const rB = await runTask({ sessionId: SID_B, goal: 'Confirm', onEvent: () => {}, taskId: nanoid(), signal: controller.signal });
    check('6b. Session B\'s "Confirm" cannot accidentally confirm session A\'s pending reminder proposal', !rB.result.toLowerCase().includes('check the mailbox again'), `result=${rB.result}`);
    clearAll(SID);
    clearAll(SID_B);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  try { require('fs').rmSync(TEST_REMINDERS_PATH, { force: true }); require('fs').rmSync(TEST_PREFS_PATH, { force: true }); } catch {}
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error('Fatal error:', e);
  try { require('fs').rmSync(TEST_REMINDERS_PATH, { force: true }); require('fs').rmSync(TEST_PREFS_PATH, { force: true }); } catch {}
  process.exit(1);
});
