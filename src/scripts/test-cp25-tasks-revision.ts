/**
 * Checkpoint 25 §Tasks — conversational proposal revision (Priority 2).
 * Due-date revision (Google Tasks is date-only — never fabricates a
 * time), and conservative title revision only when Tasks is the sole
 * capability with anything revisable pending.
 */
const TEST_PREFS_PATH = require('os').tmpdir() + '/jarvis-cp25-tasks-revision-' + Date.now() + '.json';
process.env.JARVIS_PREFERENCES_PATH = TEST_PREFS_PATH;

process.env.USE_MOCK_GMAIL = 'true';
process.env.USE_MOCK_CALENDAR = 'true';
process.env.USE_MOCK_TASKS = 'true';
process.env.USE_MOCK_CONTACTS = 'true';

import { runTask } from '@/core/agent/task-manager';
import { pendingActionStore } from '@/core/capabilities/gmail/pending-action';
import { calendarPendingActionStore } from '@/core/capabilities/calendar/pending-action';
import { tasksPendingActionStore } from '@/core/capabilities/tasks/pending-action';
import { getTasksClient } from '@/core/capabilities/tasks/resolve';
import { nanoid } from 'nanoid';

const SID = 'test-session-a';
const SID_B = 'test-session-b';

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

// Test-determinism fix — see test-checkpoint22-context.ts's identical
// helper for the full rationale: derives a replacement weekday from the
// ACTUAL pending proposal's existing "tomorrow" due date (never from the
// test process's own independent `new Date().getDay()` read), guaranteed
// distinct from it for all 7 possible weekdays. Used only for test 13
// below, the one assertion that actually failed (a hardcoded "Friday"
// collided with "tomorrow" specifically on Thursdays) — production date
// semantics and every other test in this file are unchanged.
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Timezone-safe weekday for a Tasks date-only `due` value — mirrors tasks/datetime.ts's own formatDueDate() parsing technique rather than `new Date(due).getDay()`, which can shift the calendar day backward in a negative-UTC-offset timezone. */
function dateOnlyWeekday(due: string): number {
  const [y, m, d] = due.slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d).getDay();
}

/** Offset +3 from the EXISTING due date's weekday — always resolves to exactly 4 days from today, provably distinct from "tomorrow" (1 day) for all 7 weekdays. */
function distinctRevisionWeekdayFromDue(dueIso: string): { name: string; weekday: number } {
  const weekday = (dateOnlyWeekday(dueIso) + 3) % 7;
  return { name: WEEKDAY_NAMES[weekday], weekday };
}

async function taskCount(query: string): Promise<number> {
  const client = getTasksClient();
  const result = await client.searchTasks(query, 20);
  return result.tasks.length;
}

async function main() {
  clearAllPending(SID);
  clearAllPending(SID_B);

  // ---------- 13. due-date revision ----------
  {
    clearAllPending(SID);
    await runTask({ sessionId: SID, goal: 'Remind me to pay rent tomorrow.', onEvent: () => {}, taskId: nanoid() });
    const before = tasksPendingActionStore.active(SID)!.proposal;
    const revisionWeekday = distinctRevisionWeekdayFromDue(before.due!);
    const r = await runTask({ sessionId: SID, goal: `Actually make it ${revisionWeekday.name}.`, onEvent: () => {}, taskId: nanoid() });
    const after = tasksPendingActionStore.active(SID)!.proposal;
    check(
      `13. due-date revision — "Actually make it ${revisionWeekday.name}." changes the due date`,
      /UPDATED TASK READY FOR CONFIRMATION/.test(r.result) && after.due !== before.due && dateOnlyWeekday(after.due!) === revisionWeekday.weekday,
      `before=${before.due} after=${after.due} result=${r.result}`
    );
    check('13b. title preserved by a date-only revision', after.title === before.title);
    clearAllPending(SID);
  }

  // ---------- 14. title revision ----------
  {
    clearAllPending(SID);
    await runTask({ sessionId: SID, goal: 'Create a task to call Alice tomorrow.', onEvent: () => {}, taskId: nanoid() });
    const before = tasksPendingActionStore.active(SID)!.proposal;
    check('14-setup. original task title', before.title === 'Call Alice', `title=${before.title}`);
    const r = await runTask({ sessionId: SID, goal: 'Change it to email Alice.', onEvent: () => {}, taskId: nanoid() });
    const after = tasksPendingActionStore.active(SID)!.proposal;
    check(
      '14. title revision — "Change it to email Alice." replaces the task title',
      /UPDATED TASK READY FOR CONFIRMATION/.test(r.result) && after.title === 'Email Alice',
      `title=${after.title} result=${r.result}`
    );
    check('14b. due date preserved by a title-only revision', after.due === before.due);
    clearAllPending(SID);
  }

  // ---------- 15. revision remains a proposal (never confirms) ----------
  {
    clearAllPending(SID);
    const before = await taskCount('rent');
    await runTask({ sessionId: SID, goal: 'Remind me to pay rent tomorrow.', onEvent: () => {}, taskId: nanoid() });
    const r = await runTask({ sessionId: SID, goal: 'Actually make it Friday.', onEvent: () => {}, taskId: nanoid() });
    const after = await taskCount('rent');
    check(
      '15. revision never confirms — proposal still pending, zero real tasks created',
      before === after && !!tasksPendingActionStore.active(SID) && r.outcome !== 'blocked',
      `before=${before} after=${after} result=${r.result}`
    );
    clearAllPending(SID);
  }

  // ---------- 16. repeated revision remains one proposal ----------
  {
    clearAllPending(SID);
    await runTask({ sessionId: SID, goal: 'Remind me to pay rent tomorrow.', onEvent: () => {}, taskId: nanoid() });
    await runTask({ sessionId: SID, goal: 'Actually make it Friday.', onEvent: () => {}, taskId: nanoid() });
    await runTask({ sessionId: SID, goal: 'Actually make it Monday.', onEvent: () => {}, taskId: nanoid() });
    const final = tasksPendingActionStore.active(SID)!.proposal;
    check('16. repeated revision — exactly one active proposal, reflecting the FINAL revision (Monday)', new Date(final.due!).getUTCDay() === 1 && tasksPendingActionStore.sessionCount === 1, `due=${final.due} sessionCount=${tasksPendingActionStore.sessionCount}`);
    clearAllPending(SID);
  }

  // ---------- 17. final confirmation uses the final version ----------
  {
    clearAllPending(SID);
    const before = await taskCount('rent');
    await runTask({ sessionId: SID, goal: 'Remind me to pay rent tomorrow.', onEvent: () => {}, taskId: nanoid() });
    await runTask({ sessionId: SID, goal: 'Actually make it Friday.', onEvent: () => {}, taskId: nanoid() });
    const r = await runTask({ sessionId: SID, goal: 'Create it.', onEvent: () => {}, taskId: nanoid() });
    const after = await taskCount('rent');
    check('17. "Create it." creates exactly one real task, reflecting the final revision (Friday)', after === before + 1 && /^Created /.test(r.result), `before=${before} after=${after} result=${r.result}`);
    const second = await runTask({ sessionId: SID, goal: 'Create it.', onEvent: () => {}, taskId: nanoid() });
    const afterSecond = await taskCount('rent');
    check('17b. repeated confirmation does not create a second task', afterSecond === after, `result=${second.result}`);
    clearAllPending(SID);
  }

  // ---------- 18. cross-session blocked ----------
  {
    clearAllPending(SID);
    clearAllPending(SID_B);
    await runTask({ sessionId: SID, goal: 'Remind me to pay rent tomorrow.', onEvent: () => {}, taskId: nanoid() });
    const before = tasksPendingActionStore.active(SID)!.proposal;
    const r = await runTask({ sessionId: SID_B, goal: 'Actually make it Friday.', onEvent: () => {}, taskId: nanoid() });
    const after = tasksPendingActionStore.active(SID)!.proposal;
    check('18. Session B\'s revision attempt does not touch Session A\'s pending task proposal', after.due === before.due, `result=${r.result}`);
    check('18b. Session B has nothing pending of its own', !tasksPendingActionStore.active(SID_B));
    clearAllPending(SID);
    clearAllPending(SID_B);
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
