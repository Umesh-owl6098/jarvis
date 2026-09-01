/**
 * Checkpoint 25 §Routing/safety — explicit new commands beat revision,
 * multi-pending ambiguity resolution, the CP24/CP25 boundary, prompt-
 * injection isolation, persistent-preference isolation, and confirmation
 * that CP21/post-CP23/CP24's existing cancellation semantics are
 * completely unaffected by this checkpoint.
 */
const TEST_PREFS_PATH = require('os').tmpdir() + '/jarvis-cp25-routing-safety-' + Date.now() + '.json';
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
import { nanoid } from 'nanoid';
import { readFileSync } from 'fs';

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

async function main() {
  clearAll(SID);
  preferencesStore.forgetAll();

  // ---------- 27. no active action + "Make it 3 instead" -> no mutation ----------
  {
    clearAll(SID);
    const r = await runTask({ sessionId: SID, goal: 'Make it 3 instead.', onEvent: () => {}, taskId: nanoid() });
    check(
      '27. no active action anywhere — "Make it 3 instead." causes zero mutation (falls through to ordinary routing, never fabricates a proposal)',
      !calendarPendingActionStore.active(SID) && !tasksPendingActionStore.active(SID) && !pendingActionStore.active(SID) && !/UPDATED/.test(r.result),
      `result=${r.result}`
    );
    clearAll(SID);
  }

  // ---------- 28. explicit Gmail read beats Calendar revision context ----------
  {
    clearAll(SID);
    await runTask({ sessionId: SID, goal: 'Schedule a meeting with Alice tomorrow at 2 PM', onEvent: () => {}, taskId: nanoid() });
    const before = calendarPendingActionStore.active(SID)!.proposal.start;
    const r = await runTask({ sessionId: SID, goal: "What's in my inbox?", onEvent: () => {}, taskId: nanoid() });
    const after = calendarPendingActionStore.active(SID)!.proposal.start;
    check('28. an explicit Gmail read beats Calendar revision context — Gmail executes, Calendar proposal untouched', r.capability?.selected === 'gmail' && before === after, `capability=${r.capability?.selected} result=${r.result?.slice(0, 80)}`);
    clearAll(SID);
  }

  // ---------- 29. explicit Tasks command beats Gmail revision context ----------
  {
    clearAll(SID);
    await runTask({ sessionId: SID, goal: 'Draft an email to Alice saying hello.', onEvent: () => {}, taskId: nanoid() });
    const beforeDraftId = pendingActionStore.active(SID)!.draftId;
    const r = await runTask({ sessionId: SID, goal: 'Create a task to buy milk tomorrow.', onEvent: () => {}, taskId: nanoid() });
    const afterDraftId = pendingActionStore.active(SID)?.draftId;
    check(
      '29. an explicit Tasks command beats Gmail revision context — Tasks proposal created, Gmail draft untouched',
      r.capability?.selected === 'tasks' && !!r.tasks?.pendingAction && afterDraftId === beforeDraftId,
      `capability=${r.capability?.selected} result=${r.result?.slice(0, 80)}`
    );
    clearAll(SID);
  }

  // ---------- 30. explicit Calendar command beats Tasks revision context ----------
  {
    clearAll(SID);
    await runTask({ sessionId: SID, goal: 'Remind me to pay rent tomorrow.', onEvent: () => {}, taskId: nanoid() });
    const beforeDue = tasksPendingActionStore.active(SID)!.proposal.due;
    const r = await runTask({ sessionId: SID, goal: 'Schedule a meeting with Alice tomorrow at 2 PM', onEvent: () => {}, taskId: nanoid() });
    const afterDue = tasksPendingActionStore.active(SID)?.proposal.due;
    check(
      '30. an explicit Calendar command beats Tasks revision context — Calendar proposal created, Tasks proposal untouched',
      r.capability?.selected === 'calendar' && !!r.calendar?.pendingAction && afterDue === beforeDue,
      `capability=${r.capability?.selected} result=${r.result?.slice(0, 80)}`
    );
    clearAll(SID);
  }

  // ---------- 31/32. Calendar + Tasks pending + ambiguous revision -> clarification, zero mutation ----------
  {
    clearAll(SID);
    await runTask({ sessionId: SID, goal: 'Schedule a meeting with Alice tomorrow at 2 PM', onEvent: () => {}, taskId: nanoid() });
    await runTask({ sessionId: SID, goal: 'Remind me to pay rent tomorrow.', onEvent: () => {}, taskId: nanoid() });
    const calBefore = calendarPendingActionStore.active(SID)!.proposal.start;
    const taskBefore = tasksPendingActionStore.active(SID)!.proposal.due;
    const r = await runTask({ sessionId: SID, goal: 'Actually make it Friday.', onEvent: () => {}, taskId: nanoid() });
    check('31. ambiguous revision with both Calendar and Tasks pending — asks which one, never guesses', r.outcome === 'blocked' && /calendar event or the task/i.test(r.result), `result=${r.result}`);
    const calAfter = calendarPendingActionStore.active(SID)!.proposal.start;
    const taskAfter = tasksPendingActionStore.active(SID)!.proposal.due;
    check('32. ambiguity causes ZERO mutation — neither proposal changed', calBefore === calAfter && taskBefore === taskAfter);

    // ---------- 33. explicit capability reference resolves ambiguity safely ----------
    const resolved = await runTask({ sessionId: SID, goal: 'The task.', onEvent: () => {}, taskId: nanoid() });
    const calStillSame = calendarPendingActionStore.active(SID)!.proposal.start;
    const taskNow = tasksPendingActionStore.active(SID)!.proposal.due;
    check(
      '33. "The task." resolves the ambiguity — ONLY the task is revised, Calendar proposal still untouched',
      /UPDATED TASK READY FOR CONFIRMATION/.test(resolved.result) && calStillSame === calBefore && taskNow !== taskBefore && new Date(taskNow!).getUTCDay() === 5,
      `result=${resolved.result}`
    );
    clearAll(SID);
  }

  // ---------- 34/35/36. retrieved content structurally cannot revise ----------
  {
    const runnerFiles = [
      'src/core/capabilities/gmail/runner.ts',
      'src/core/capabilities/calendar/runner.ts',
      'src/core/capabilities/tasks/runner.ts',
    ];
    let anyRunnerTouchesRevision = false;
    for (const f of runnerFiles) {
      const src = readFileSync(f, 'utf-8');
      if (src.includes('proposal-revision') || src.includes('attemptProposalRevision')) anyRunnerTouchesRevision = true;
    }
    check(
      '34/35/36. no capability runner (Gmail/Calendar/Tasks, which process RETRIEVED content — email bodies, event descriptions, task notes) ever imports proposal-revision.ts — a revision can only ever originate from the raw top-level user command in task-manager.ts',
      !anyRunnerTouchesRevision
    );
    const taskManagerSrc = readFileSync('src/core/agent/task-manager.ts', 'utf-8');
    check('34b. task-manager.ts IS the actual (sole intended) caller of attemptProposalRevision', taskManagerSrc.includes('attemptProposalRevision('));
  }
  {
    // Behavioral reinforcement: an email whose OWN content contains
    // revision-shaped text must not revise a pending Calendar proposal
    // merely because that text was read/summarized.
    clearAll(SID);
    await runTask({ sessionId: SID, goal: 'Schedule a meeting with Alice tomorrow at 2 PM', onEvent: () => {}, taskId: nanoid() });
    const before = calendarPendingActionStore.active(SID)!.proposal.start;
    await runTask({ sessionId: SID, goal: 'find my latest email', onEvent: () => {}, taskId: nanoid() });
    const after = calendarPendingActionStore.active(SID)!.proposal.start;
    check('34c. reading Gmail content (whatever it contains) never revises the pending Calendar proposal', before === after);
    clearAll(SID);
  }

  // ---------- 37. revision cannot alter persistent preferences ----------
  {
    clearAll(SID);
    preferencesStore.forgetAll();
    await runTask({ sessionId: SID, goal: 'Schedule a meeting with Alice tomorrow at 2 PM', onEvent: () => {}, taskId: nanoid() });
    await runTask({ sessionId: SID, goal: 'Make it 30 minutes.', onEvent: () => {}, taskId: nanoid() });
    const stored = preferencesStore.get('meetingDurationMinutes');
    check('37. "Make it 30 minutes." (a proposal revision) never writes meetingDurationMinutes to persistent preferences', stored === undefined, `stored=${stored}`);
    clearAll(SID);
  }

  // ---------- 38. CP24 pending-slot behavior remains intact ----------
  {
    clearAll(SID);
    const r1 = await runTask({ sessionId: SID, goal: 'email Alice', onEvent: () => {}, taskId: nanoid() });
    check('38a. CP24 clarification still fires unaffected by CP25', r1.result === 'What would you like the email to say?' && pendingSlotStore.active(SID)?.kind === 'gmail_draft_body');
    const r2 = await runTask({ sessionId: SID, goal: "Tell her I'll be there at 4.", onEvent: () => {}, taskId: nanoid() });
    check('38b. CP24 slot completion still creates a real draft unaffected by CP25', /DRAFT CREATED/.test(r2.result) && !pendingSlotStore.active(SID));
    clearAll(SID);
  }

  // ---------- 39. "Cancel it" behavior remains intact ----------
  {
    clearAll(SID);
    await runTask({ sessionId: SID, goal: 'Schedule a meeting with Alice tomorrow at 2 PM', onEvent: () => {}, taskId: nanoid() });
    const r = await runTask({ sessionId: SID, goal: 'Cancel it.', onEvent: () => {}, taskId: nanoid() });
    check('39a. "Cancel it." with a single pending Calendar action — unaffected by CP25', /calendar change was not made/i.test(r.result) && !calendarPendingActionStore.active(SID));
    clearAll(SID);

    await runTask({ sessionId: SID, goal: 'Schedule a meeting with Alice tomorrow at 2 PM', onEvent: () => {}, taskId: nanoid() });
    await runTask({ sessionId: SID, goal: 'Remind me to pay rent tomorrow.', onEvent: () => {}, taskId: nanoid() });
    const ambiguousCancel = await runTask({ sessionId: SID, goal: 'Cancel it.', onEvent: () => {}, taskId: nanoid() });
    check(
      '39b. "Cancel it." with two DIFFERENT pending actions still asks which one — pre-existing multi-pending semantics unaffected by CP25',
      /which should i cancel/i.test(ambiguousCancel.result) && !!calendarPendingActionStore.active(SID) && !!tasksPendingActionStore.active(SID),
      `result=${ambiguousCancel.result}`
    );
    clearAll(SID);
  }

  // ---------- 40. "Cancel all" behavior remains intact ----------
  {
    clearAll(SID);
    await runTask({ sessionId: SID, goal: 'Schedule a meeting with Alice tomorrow at 2 PM', onEvent: () => {}, taskId: nanoid() });
    await runTask({ sessionId: SID, goal: 'Remind me to pay rent tomorrow.', onEvent: () => {}, taskId: nanoid() });
    await runTask({ sessionId: SID, goal: 'email Alice', onEvent: () => {}, taskId: nanoid() });
    const r = await runTask({ sessionId: SID, goal: 'Cancel all.', onEvent: () => {}, taskId: nanoid() });
    check(
      '40. "Cancel all." clears the real Calendar action, the real Tasks action, AND the CP24 Gmail slot (post-CP24 architecture unaffected by CP25)',
      !calendarPendingActionStore.active(SID) && !tasksPendingActionStore.active(SID) && !pendingSlotStore.active(SID),
      `result=${r.result}`
    );
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
