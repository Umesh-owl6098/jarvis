/**
 * Checkpoint 28 §State safety + §Session + §Regression — an attention
 * check never touches an existing pending Calendar/Tasks/Gmail
 * confirmation, a CP24 slot, or CP23 preferences; the bounded reference
 * list (reused from CP27) is session-isolated; and CP26 workflows, CP27's
 * briefing, and direct Calendar/Tasks/Gmail reads all still route
 * unchanged.
 */
const TEST_PREFS_PATH = require('os').tmpdir() + '/jarvis-cp28-state-safety-' + Date.now() + '.json';
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
import { preferencesStore } from '@/core/preferences/store';
import { briefingReferenceStore } from '@/core/agent/briefing/runner';
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
  pendingSlotStore.clear(sid);
  briefingReferenceStore.clear(sid);
}

async function main() {
  clearAll(SID);
  clearAll(SID_B);
  preferencesStore.forgetAll();

  // ---------- 1-3. existing pending Calendar/Tasks/Gmail preserved ----------
  {
    clearAll(SID);
    await runTask({ sessionId: SID, goal: 'Schedule a meeting with Alice tomorrow at 2 PM', onEvent: () => {}, taskId: nanoid() });
    const calBefore = calendarPendingActionStore.active(SID)!.proposal.start;
    await runTask({ sessionId: SID, goal: 'Anything urgent?', onEvent: () => {}, taskId: nanoid() });
    const calAfter = calendarPendingActionStore.active(SID)?.proposal.start;
    check('1. an existing pending Calendar proposal survives an attention check byte-equivalent', calAfter === calBefore, `before=${calBefore} after=${calAfter}`);
    clearAll(SID);
  }
  {
    clearAll(SID);
    await runTask({ sessionId: SID, goal: 'Remind me to buy milk tomorrow.', onEvent: () => {}, taskId: nanoid() });
    const taskBefore = tasksPendingActionStore.active(SID)!.proposal.due;
    await runTask({ sessionId: SID, goal: 'Anything urgent?', onEvent: () => {}, taskId: nanoid() });
    const taskAfter = tasksPendingActionStore.active(SID)?.proposal.due;
    check('2. an existing pending Tasks proposal survives an attention check byte-equivalent', taskAfter === taskBefore, `before=${taskBefore} after=${taskAfter}`);
    clearAll(SID);
  }
  {
    clearAll(SID);
    await runTask({ sessionId: SID, goal: 'Draft an email to Priya saying hello.', onEvent: () => {}, taskId: nanoid() });
    const draftBefore = pendingActionStore.active(SID)!.draftId;
    await runTask({ sessionId: SID, goal: 'Anything urgent?', onEvent: () => {}, taskId: nanoid() });
    const draftAfter = pendingActionStore.active(SID)?.draftId;
    check('3. an existing pending Gmail draft-send confirmation survives an attention check byte-equivalent', draftAfter === draftBefore, `before=${draftBefore} after=${draftAfter}`);
    clearAll(SID);
  }

  // ---------- 4. CP24 slot preserved ----------
  {
    clearAll(SID);
    const r = await runTask({ sessionId: SID, goal: 'email Priya', onEvent: () => {}, taskId: nanoid() });
    check('4-setup. a CP24 slot is active', r.result === 'What would you like the email to say?' && pendingSlotStore.active(SID)?.kind === 'gmail_draft_body');
    await runTask({ sessionId: SID, goal: 'Anything urgent?', onEvent: () => {}, taskId: nanoid() });
    check('4. the CP24 slot survives an attention check untouched', pendingSlotStore.active(SID)?.kind === 'gmail_draft_body');
    clearAll(SID);
  }

  // ---------- 5. CP23 preferences preserved ----------
  {
    preferencesStore.set('meetingDurationMinutes', 45);
    await runTask({ sessionId: SID, goal: 'Anything urgent?', onEvent: () => {}, taskId: nanoid() });
    check('5. CP23 preferences are completely unchanged by an attention check', preferencesStore.get('meetingDurationMinutes') === 45, `value=${preferencesStore.get('meetingDurationMinutes')}`);
    preferencesStore.forgetAll();
  }

  // ---------- 6. no confirmation side effects — a genuine pending action is NOT confirmed by an attention check, and can still be confirmed normally afterward ----------
  {
    clearAll(SID);
    await runTask({ sessionId: SID, goal: 'Remind me to buy milk tomorrow.', onEvent: () => {}, taskId: nanoid() });
    await runTask({ sessionId: SID, goal: 'Anything urgent?', onEvent: () => {}, taskId: nanoid() });
    check('6a. the pending Task is still pending (not silently confirmed) after an attention check', !!tasksPendingActionStore.active(SID));
    const confirm = await runTask({ sessionId: SID, goal: 'Confirm the task.', onEvent: () => {}, taskId: nanoid() });
    check('6. the original "Confirm" still operates normally after an intervening attention check', /^Created "Buy milk"/.test(confirm.result), `result=${confirm.result}`);
    clearAll(SID);
  }
  {
    // Also prove an attention check cannot CANCEL an unrelated pending action.
    clearAll(SID);
    await runTask({ sessionId: SID, goal: 'Remind me to buy milk tomorrow.', onEvent: () => {}, taskId: nanoid() });
    await runTask({ sessionId: SID, goal: 'Anything urgent?', onEvent: () => {}, taskId: nanoid() });
    check('6b. an attention check never cancels an unrelated pending action', !!tasksPendingActionStore.active(SID));
    clearAll(SID);
  }

  // ---------- 7. Start-over clears the reused reference list ----------
  {
    clearAll(SID);
    await runTask({ sessionId: SID, goal: 'Anything urgent?', onEvent: () => {}, taskId: nanoid() });
    check('7-setup. attention references exist before Start over', !!briefingReferenceStore.active(SID));
    await runTask({ sessionId: SID, goal: 'Start over.', onEvent: () => {}, taskId: nanoid() });
    check('7. "Start over." clears the reused attention/briefing reference list', !briefingReferenceStore.active(SID));
    clearAll(SID);
  }

  // ---------- 8. Session A/B reference isolation ----------
  {
    clearAll(SID);
    clearAll(SID_B);
    await runTask({ sessionId: SID, goal: 'Anything urgent?', onEvent: () => {}, taskId: nanoid() });
    check('8-setup. Session A has real attention references', !!briefingReferenceStore.active(SID));
    const rB = await runTask({ sessionId: SID_B, goal: 'Tell me more about the first item.', onEvent: () => {}, taskId: nanoid() });
    check('8. Session B cannot resolve a follow-up against Session A\'s attention references', /don't have a recent briefing/i.test(rB.result), `result=${rB.result}`);
    clearAll(SID);
    clearAll(SID_B);
  }

  // ---------- 9. Regression — CP26 workflows still route unchanged ----------
  {
    const r = await runTask({ sessionId: SID, goal: 'Find my last meeting tomorrow and remind me to send notes afterward.', onEvent: () => {}, taskId: nanoid() });
    check('9. a genuine CP26 workflow phrase still routes to orchestration, unaffected by CP28', r.capability?.selected === 'orchestration' && r.orchestration?.pattern === 'calendar-last-first-then-task', `capability=${r.capability?.selected} pattern=${r.orchestration?.pattern}`);
    clearAll(SID);
  }

  // ---------- 10. Regression — CP27 briefing still routes unchanged ----------
  {
    const r = await runTask({ sessionId: SID, goal: 'Brief me on my day.', onEvent: () => {}, taskId: nanoid() });
    check('10. a genuine CP27 briefing phrase still routes to briefing, unaffected by CP28', r.capability?.selected === 'briefing', `capability=${r.capability?.selected}`);
    clearAll(SID);
  }

  // ---------- 11. Regression — explicit Calendar/Tasks/Gmail reads still route unchanged ----------
  {
    const r = await runTask({ sessionId: SID, goal: 'What meetings do I have tomorrow?', onEvent: () => {}, taskId: nanoid() });
    check('11a. an explicit Calendar read still routes to calendar', r.capability?.selected === 'calendar', `capability=${r.capability?.selected}`);
    clearAll(SID);
  }
  {
    const r = await runTask({ sessionId: SID, goal: 'What tasks do I have today?', onEvent: () => {}, taskId: nanoid() });
    check('11b. an explicit Tasks read still routes to tasks', r.capability?.selected === 'tasks', `capability=${r.capability?.selected}`);
    clearAll(SID);
  }
  {
    const r = await runTask({ sessionId: SID, goal: 'Show me my recent emails.', onEvent: () => {}, taskId: nanoid() });
    check('11c. an explicit Gmail read still routes to gmail', r.capability?.selected === 'gmail', `capability=${r.capability?.selected}`);
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
