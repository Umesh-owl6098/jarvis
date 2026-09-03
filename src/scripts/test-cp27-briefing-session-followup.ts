/**
 * Checkpoint 27 §Session/context + §Compound boundary — the bounded
 * briefing-reference follow-up ("Tell me more about the second item.") is
 * session-isolated and cleared by "Start over," a briefing never
 * interferes with an unrelated pending confirmation or authorizes a later
 * mutation, and a briefing combined with an explicit action is never
 * silently narrowed to just the briefing half.
 */
const TEST_PREFS_PATH = require('os').tmpdir() + '/jarvis-cp27-session-followup-' + Date.now() + '.json';
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

  // ---------- 46. Session B cannot access A's briefing references ----------
  {
    clearAll(SID);
    clearAll(SID_B);
    await runTask({ sessionId: SID, goal: 'Brief me on my day.', onEvent: () => {}, taskId: nanoid() });
    const aRefs = briefingReferenceStore.active(SID);
    check('46-setup. Session A has real briefing references after its own briefing', !!aRefs && aRefs.length > 0, `count=${aRefs?.length}`);

    const rB = await runTask({ sessionId: SID_B, goal: 'Tell me more about the first item.', onEvent: () => {}, taskId: nanoid() });
    check(
      "46. Session B's follow-up cannot resolve against Session A's briefing references",
      /don't have a recent briefing/i.test(rB.result),
      `result=${rB.result}`
    );
    clearAll(SID);
    clearAll(SID_B);
  }

  // ---------- follow-up itself works correctly within the SAME session ----------
  {
    clearAll(SID);
    await runTask({ sessionId: SID, goal: 'Brief me on my day.', onEvent: () => {}, taskId: nanoid() });
    const r = await runTask({ sessionId: SID, goal: 'Tell me more about the first item.', onEvent: () => {}, taskId: nanoid() });
    check('46b. within the SAME session, the follow-up resolves to real detail (not a "no briefing" refusal)', !/don't have a recent briefing/i.test(r.result) && r.result.length > 0, `result=${r.result}`);
    clearAll(SID);
  }

  // ---------- 47. "Start over" clears briefing references ----------
  {
    clearAll(SID);
    await runTask({ sessionId: SID, goal: 'Brief me on my day.', onEvent: () => {}, taskId: nanoid() });
    check('47-setup. briefing references exist before Start over', !!briefingReferenceStore.active(SID));
    await runTask({ sessionId: SID, goal: 'Start over.', onEvent: () => {}, taskId: nanoid() });
    check('47. "Start over." clears the briefing-reference list', !briefingReferenceStore.active(SID));
    const r = await runTask({ sessionId: SID, goal: 'Tell me more about the first item.', onEvent: () => {}, taskId: nanoid() });
    check('47b. a follow-up after Start over correctly reports nothing to reference', /don't have a recent briefing/i.test(r.result), `result=${r.result}`);
    clearAll(SID);
  }

  // ---------- 48. briefing does not overwrite an unrelated pending confirmation ----------
  {
    clearAll(SID);
    // Create a real, unrelated pending Task proposal first.
    await runTask({ sessionId: SID, goal: 'Remind me to buy milk tomorrow.', onEvent: () => {}, taskId: nanoid() });
    const dueBefore = tasksPendingActionStore.active(SID)?.proposal.due;
    check('48-setup. a real Tasks proposal is pending before the briefing', !!dueBefore);

    await runTask({ sessionId: SID, goal: 'Brief me on my day.', onEvent: () => {}, taskId: nanoid() });
    const dueAfter = tasksPendingActionStore.active(SID)?.proposal.due;
    check('48. the briefing leaves the unrelated pending Task proposal completely untouched', dueAfter === dueBefore, `before=${dueBefore} after=${dueAfter}`);

    const confirmResult = await runTask({ sessionId: SID, goal: 'Confirm the task.', onEvent: () => {}, taskId: nanoid() });
    check('48b. the pre-existing proposal can still be confirmed normally after an intervening briefing', /^Created "Buy milk"/.test(confirmResult.result), `result=${confirmResult.result}`);
    clearAll(SID);
  }

  // ---------- 49. briefing does not authorize a later mutation ----------
  {
    clearAll(SID);
    await runTask({ sessionId: SID, goal: 'Brief me on my day.', onEvent: () => {}, taskId: nanoid() });
    // A bare "Confirm" with NOTHING pending (the briefing created no
    // authorization state at all) must not execute anything — it falls
    // through to normal routing exactly as if no briefing had ever run.
    check('49-setup. nothing is pending after a briefing', !pendingActionStore.active(SID) && !calendarPendingActionStore.active(SID) && !tasksPendingActionStore.active(SID));
    const r = await runTask({ sessionId: SID, goal: 'Confirm the task.', onEvent: () => {}, taskId: nanoid() });
    check('49. "Confirm the task." after a briefing (nothing pending) never creates/executes a mutation', !tasksPendingActionStore.active(SID) && !r.result.includes('Created'), `result=${r.result.slice(0, 150)}`);
    clearAll(SID);
  }

  // ---------- 50. "Brief me and create a task" does not silently drop either half ----------
  {
    clearAll(SID);
    const r = await runTask({ sessionId: SID, goal: 'Brief me on my day and create a task to prepare for my meeting.', onEvent: () => {}, taskId: nanoid() });
    check('50. the compound request is reported as unsupported, not silently narrowed to just the briefing', r.capability?.selected === 'briefing' && r.outcome === 'blocked', `capability=${r.capability?.selected} outcome=${r.outcome}`);
    check('50b. the response names the dropped half explicitly ("create a task...")', /create a task/i.test(r.result), `result=${r.result}`);
    check('50c. no real Task was silently created', !tasksPendingActionStore.active(SID));
    clearAll(SID);
  }

  // ---------- 51. briefing remains separate from CP26 workflow execution ----------
  {
    clearAll(SID);
    // A genuine CP26 workflow phrase (unrelated to briefing vocabulary)
    // still resolves to 'orchestration', never 'briefing' — the two
    // grammars never collide.
    const r = await runTask({ sessionId: SID, goal: 'Find my last meeting tomorrow and remind me to send notes afterward.', onEvent: () => {}, taskId: nanoid() });
    check('51. a genuine CP26 workflow phrase still routes to orchestration, not briefing', r.capability?.selected === 'orchestration' && r.orchestration?.pattern === 'calendar-last-first-then-task', `capability=${r.capability?.selected} pattern=${r.orchestration?.pattern}`);
    clearAll(SID);
  }
  {
    // And the reverse — a genuine briefing phrase never resolves to orchestration.
    const r = await runTask({ sessionId: SID, goal: 'Brief me on my day.', onEvent: () => {}, taskId: nanoid() });
    check('51b. a genuine briefing phrase never routes to orchestration', r.capability?.selected === 'briefing' && !r.orchestration, `capability=${r.capability?.selected} orchestration=${JSON.stringify(r.orchestration)}`);
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
