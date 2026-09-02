/**
 * Checkpoint 26 §Conversation + §Session isolation — CP22-25's existing
 * mechanisms (revision, CP24 slots, "Start over") continue to work
 * unchanged on workflow-produced state, and every workflow-produced
 * pending action/context remains keyed to the existing opaque sessionId
 * — no new global/fallback workflow session is introduced.
 */
const TEST_PREFS_PATH = require('os').tmpdir() + '/jarvis-cp26-conversation-session-' + Date.now() + '.json';
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
import { getCalendarClient } from '@/core/capabilities/calendar/resolve';
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
}

async function seedMeetingWith(email: string, title: string, daysFromNow = 1, hour = 14) {
  const client = getCalendarClient();
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() + daysFromNow, hour, 0, 0, 0);
  const end = new Date(start.getTime() + 30 * 60000);
  await client.createEvent({ kind: 'create', title, start: start.toISOString(), end: end.toISOString(), timezone: 'UTC', attendees: [email] });
}

async function runWorkflow(sid: string) {
  return runTask({
    sessionId: sid,
    goal: "Find my meeting with Alice tomorrow, draft her an email saying I'll be there, and remind me to send the notes Friday.",
    onEvent: () => {},
    taskId: nanoid(),
  });
}

async function main() {
  clearAll(SID);
  clearAll(SID_B);
  preferencesStore.forgetAll();
  // Seeded ONCE and reused by every test below — the mock calendar has
  // no per-test reset, so re-seeding "Alice tomorrow" repeatedly would
  // make the lookup itself ambiguous (2+ matching events).
  await seedMeetingWith('alice@example.com', 'Coffee with Alice');

  // ---------- 27/29. CP25 can revise a workflow-produced Task proposal; revision remains unconfirmed ----------
  {
    clearAll(SID);
    await runWorkflow(SID);
    const before = tasksPendingActionStore.active(SID)!.proposal.due;
    const r = await runTask({ sessionId: SID, goal: 'Actually make it Monday.', onEvent: () => {}, taskId: nanoid() });
    const after = tasksPendingActionStore.active(SID)?.proposal.due;
    check('27. CP25 revises the workflow-produced Task proposal ("Actually make it Monday.")', /UPDATED TASK READY FOR CONFIRMATION/.test(r.result) && after !== before && new Date(after!).getUTCDay() === 1, `before=${before} after=${after} result=${r.result}`);
    check('29. the revision itself never confirms — the task is still a pending proposal, not created', !!tasksPendingActionStore.active(SID) && r.outcome !== 'blocked');
    clearAll(SID);
  }

  // ---------- 28. CP25 can revise a workflow-produced Gmail draft ----------
  {
    clearAll(SID);
    await runWorkflow(SID);
    const draftId = pendingActionStore.active(SID)!.draftId;
    const r = await runTask({ sessionId: SID, goal: "Change it to say I'll arrive five minutes early.", onEvent: () => {}, taskId: nanoid() });
    check('28. CP25 revises the workflow-produced Gmail draft using its OWN existing mechanism (no special workflow-only revision logic)', /DRAFT UPDATED/.test(r.result) && /five minutes early/.test(r.result), `result=${r.result}`);
    check('28b. same draft ID preserved from the workflow', pendingActionStore.active(SID)!.draftId === draftId);
    clearAll(SID);
  }

  // ---------- 30. CP24 missing-field clarification remains ONE slot ----------
  {
    clearAll(SID);
    await runWorkflow(SID);
    // The workflow already produced real Gmail/Tasks pending actions (not
    // CP24 slots) — a fresh, unrelated "email GV" now creates the ONE
    // permitted slot, coexisting with (not replacing or duplicating) the
    // workflow's own real pending actions.
    const r = await runTask({ sessionId: SID, goal: 'email Priya', onEvent: () => {}, taskId: nanoid() });
    check('30. a fresh missing-field question after a workflow still creates exactly ONE CP24 slot', r.result === 'What would you like the email to say?' && pendingSlotStore.active(SID)?.kind === 'gmail_draft_body');
    check('30b. the workflow\'s own earlier Gmail draft pending-action is untouched by the new slot', !!pendingActionStore.active(SID));
    clearAll(SID);
  }

  // ---------- 31. explicit new command beats workflow follow-up state ----------
  {
    clearAll(SID);
    await runWorkflow(SID);
    const taskBefore = tasksPendingActionStore.active(SID)!.proposal.due;
    const r = await runTask({ sessionId: SID, goal: "What's my calendar today?", onEvent: () => {}, taskId: nanoid() });
    check('31. an explicit new command (a Calendar read) executes normally after a workflow, not swallowed as a revision', r.capability?.selected === 'calendar', `capability=${r.capability?.selected} result=${r.result.slice(0, 80)}`);
    const taskAfter = tasksPendingActionStore.active(SID)?.proposal.due;
    check('31b. the workflow\'s own pending Task proposal is untouched by the unrelated command', taskAfter === taskBefore);
    clearAll(SID);
  }

  // ---------- 32. "Start over" clears ephemeral conversational state without changing preferences ----------
  {
    clearAll(SID);
    preferencesStore.set('meetingDurationMinutes', 45);
    await runWorkflow(SID);
    await runTask({ sessionId: SID, goal: 'email Priya', onEvent: () => {}, taskId: nanoid() });
    check('32-setup. a CP24 slot is active before Start over', !!pendingSlotStore.active(SID));
    await runTask({ sessionId: SID, goal: 'Start over.', onEvent: () => {}, taskId: nanoid() });
    check('32. "Start over." clears the CP24 slot (ephemeral conversational state)', !pendingSlotStore.active(SID));
    check('32b. persistent preferences (meetingDurationMinutes) are NEVER touched by "Start over."', preferencesStore.get('meetingDurationMinutes') === 45);
    preferencesStore.forgetAll();
    clearAll(SID);
  }

  // ---------- 33/34/35/36. Session isolation ----------
  // Deliberately gives Session B its OWN separate, matching-type pending
  // state (rather than nothing at all) — this is a STRONGER isolation
  // proof (confirming/revising/cancelling B's own item never touches A's,
  // even when both are simultaneously active) and, as a side effect,
  // keeps every command on a fast, deterministic path: a session with
  // truly nothing pending falls through this module's own trigger checks
  // to the generic browser/OmniRoute fallback, which is real (non-mocked)
  // network behavior — slow, and not what this test is about.
  {
    clearAll(SID);
    clearAll(SID_B);
    await runWorkflow(SID); // Session A: real Gmail draft + Tasks proposal via the 3-step workflow
    const aDraftId = pendingActionStore.active(SID)!.draftId;
    const aTaskDueBefore = tasksPendingActionStore.active(SID)!.proposal.due;

    // Session B: its own, independently-created Gmail draft + Tasks proposal.
    await runTask({ sessionId: SID_B, goal: 'Draft an email to Priya saying B has its own draft.', onEvent: () => {}, taskId: nanoid() });
    await runTask({ sessionId: SID_B, goal: 'Remind me to buy milk tomorrow.', onEvent: () => {}, taskId: nanoid() });
    const bDraftId = pendingActionStore.active(SID_B)!.draftId;
    const bTaskDueBefore = tasksPendingActionStore.active(SID_B)!.proposal.due;

    // ---- 33. confirm ----
    const confirmB = await runTask({ sessionId: SID_B, goal: 'Confirm the task.', onEvent: () => {}, taskId: nanoid() });
    check('33. "Confirm the task." in Session B executes ONLY Session B\'s own task', /^Created "Buy milk"/.test(confirmB.result), `result=${confirmB.result}`);
    check('33b. Session A\'s Task proposal is completely untouched', tasksPendingActionStore.active(SID)?.proposal.due === aTaskDueBefore);

    // ---- 34. revise (Session A still has its own pending task; Session B's is now confirmed/gone, so seed a fresh one) ----
    await runTask({ sessionId: SID_B, goal: 'Remind me to water plants tomorrow.', onEvent: () => {}, taskId: nanoid() });
    const bTaskDueBefore2 = tasksPendingActionStore.active(SID_B)!.proposal.due;
    const revised = await runTask({ sessionId: SID_B, goal: 'Actually make it Friday.', onEvent: () => {}, taskId: nanoid() });
    check('34. "Actually make it Friday." in Session B revises ONLY Session B\'s own task', /UPDATED TASK READY FOR CONFIRMATION/.test(revised.result) && tasksPendingActionStore.active(SID_B)?.proposal.due !== bTaskDueBefore2, `result=${revised.result}`);
    check('34b. Session A\'s Task proposal is completely untouched by Session B\'s revision', tasksPendingActionStore.active(SID)?.proposal.due === aTaskDueBefore);

    // ---- 35. cancel ----
    const cancelB = await runTask({ sessionId: SID_B, goal: 'Cancel the task.', onEvent: () => {}, taskId: nanoid() });
    check('35. "Cancel the task." in Session B cancels ONLY Session B\'s own task', !tasksPendingActionStore.active(SID_B) && /task change was not made/i.test(cancelB.result), `result=${cancelB.result}`);
    check('35b. Session A\'s Task proposal survives Session B\'s cancellation', !!tasksPendingActionStore.active(SID) && tasksPendingActionStore.active(SID)!.proposal.due === aTaskDueBefore);

    // ---- 36. Gmail revision context ----
    const gmailRevised = await runTask({ sessionId: SID_B, goal: 'Change it to say revised by session B.', onEvent: () => {}, taskId: nanoid() });
    check('36. Session B can revise its OWN Gmail draft', /DRAFT UPDATED/.test(gmailRevised.result) && pendingActionStore.active(SID_B)?.draftId === bDraftId, `result=${gmailRevised.result}`);
    check('36b. Session A\'s Gmail draft (same draft ID from its own workflow) is completely untouched — different draft IDs, never cross-referenced', pendingActionStore.active(SID)?.draftId === aDraftId && aDraftId !== bDraftId);

    clearAll(SID);
    clearAll(SID_B);
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
