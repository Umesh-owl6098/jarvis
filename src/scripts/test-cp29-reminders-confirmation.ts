/**
 * Checkpoint 29 §Confirmation — creating or cancelling a persisted
 * reminder is a mutation and must go through the SAME propose-then-
 * confirm gate as Calendar/Gmail/Tasks. No persistence before an explicit
 * confirmation, duplicate confirms are idempotent, cancel-the-proposal
 * works, multi-pending bare "Confirm"/"Cancel" clarifies rather than
 * guesses, specific "Confirm the X" phrases dispatch to the right
 * capability, and there is no "Confirm all."
 */
const TEST_PREFS_PATH = require('os').tmpdir() + '/jarvis-cp29-confirm-prefs-' + Date.now() + '.json';
process.env.JARVIS_PREFERENCES_PATH = TEST_PREFS_PATH;
const TEST_REMINDERS_PATH = require('os').tmpdir() + '/jarvis-cp29-confirm-reminders-' + Date.now() + '.json';
process.env.JARVIS_REMINDERS_PATH = TEST_REMINDERS_PATH;

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

  // ---------- 1. no persistence before confirm ----------
  {
    clearAll(SID);
    const before = reminderStore.count;
    const r = await runTask({ sessionId: SID, goal: 'Remind me in 20 minutes to check the oven.', onEvent: () => {}, taskId: nanoid() });
    check('1. the initial request is answered with a PROPOSAL, not immediate creation', /confirm/i.test(r.result), `result=${r.result}`);
    check('1b. nothing was persisted yet — the request alone is not authorization', reminderStore.count === before, `before=${before} after=${reminderStore.count}`);
    check('1c. a reminder pending action IS now active for this session', !!reminderPendingActionStore.active(SID));
    clearAll(SID);
  }

  // ---------- 2. confirm creates exactly one persisted reminder ----------
  {
    clearAll(SID);
    await runTask({ sessionId: SID, goal: 'Remind me in 20 minutes to check the oven.', onEvent: () => {}, taskId: nanoid() });
    const before = reminderStore.count;
    const r = await runTask({ sessionId: SID, goal: 'Confirm', onEvent: () => {}, taskId: nanoid() });
    check('2. "Confirm" creates exactly one persisted reminder', reminderStore.count === before + 1, `before=${before} after=${reminderStore.count}`);
    check('2b. the created reminder is scheduled', reminderStore.scheduledSorted().some((x) => x.text === 'check the oven'), `all=${JSON.stringify(reminderStore.getAll())}`);
    check('2c. the confirmation result names the reminder', r.result.toLowerCase().includes('check the oven'), `result=${r.result}`);
    clearAll(SID);
  }

  // ---------- 3. duplicate confirm is idempotent — never creates a second reminder ----------
  {
    clearAll(SID);
    await runTask({ sessionId: SID, goal: 'Remind me in 20 minutes to water the plants.', onEvent: () => {}, taskId: nanoid() });
    await runTask({ sessionId: SID, goal: 'Confirm', onEvent: () => {}, taskId: nanoid() });
    const afterFirst = reminderStore.count;
    // A SECOND bare "Confirm" now has NOTHING pending anywhere (the first
    // confirm already claimed and cleared it) — like every other
    // capability, a bare ambiguous confirm word with zero active pending
    // stores is never claimed here at all (pre-existing, unrelated to
    // CP29) and falls through to generic routing; aborted quickly once
    // real browser routing genuinely starts (same bounded technique as
    // test 11 below) since this test is only about proving idempotency,
    // not about browser behavior.
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 150);
    await runTask({ sessionId: SID, goal: 'Confirm', onEvent: () => {}, taskId: nanoid(), signal: controller.signal });
    check('3. a SECOND "Confirm" with nothing pending anywhere never creates a duplicate reminder', reminderStore.count === afterFirst, `afterFirst=${afterFirst} afterSecond=${reminderStore.count}`);
  }
  // Directly exercises attemptReminderConfirmation's own "nothing
  // pending" branch (unit-level, not through the full text-routing
  // pipeline, since no unconditional reminder confirm PHRASE exists in
  // the grammar the way Calendar's "create it"/Gmail's "send it" do —
  // see the CP29 report's own note on this deliberate scope decision).
  {
    clearAll(SID);
    const { attemptReminderConfirmation } = await import('@/core/reminders/runner');
    const before = reminderStore.count;
    const r = await attemptReminderConfirmation('Confirm the reminder', nanoid(), () => {}, SID);
    check('3c. attemptReminderConfirmation with nothing pending reports an honest message, never a fabricated success', /no pending reminder/i.test(r.result), `result=${r.result}`);
    check('3d. attemptReminderConfirmation with nothing pending creates nothing', reminderStore.count === before);
    clearAll(SID);
  }

  // ---------- 4. cancel proposal — "Cancel it"/"No" rejects a pending CREATE without persisting ----------
  {
    clearAll(SID);
    const before = reminderStore.count;
    await runTask({ sessionId: SID, goal: 'Remind me in 20 minutes to check the oven.', onEvent: () => {}, taskId: nanoid() });
    const r = await runTask({ sessionId: SID, goal: 'No', onEvent: () => {}, taskId: nanoid() });
    check('4. rejecting a pending reminder creation persists nothing', reminderStore.count === before, `before=${before} after=${reminderStore.count}`);
    check('4b. the rejection is reported honestly', /not (?:set|made)/i.test(r.result), `result=${r.result}`);
    check('4c. the pending action is cleared', !reminderPendingActionStore.active(SID));
    clearAll(SID);
  }

  // ---------- 5. confirm a CANCELLATION — creates a reminder, proposes cancelling it, confirms, verifies persisted status ----------
  {
    clearAll(SID);
    await runTask({ sessionId: SID, goal: 'Remind me in 20 minutes to walk the dog.', onEvent: () => {}, taskId: nanoid() });
    await runTask({ sessionId: SID, goal: 'Confirm', onEvent: () => {}, taskId: nanoid() });
    const created = reminderStore.scheduledSorted().find((x) => x.text === 'walk the dog')!;
    check('5-setup. the reminder exists and is scheduled', created?.status === 'scheduled');

    const proposeCancel = await runTask({ sessionId: SID, goal: 'Cancel my reminder to walk the dog.', onEvent: () => {}, taskId: nanoid() });
    check('5a. cancelling a reminder is ALSO proposed first, not immediate', /confirm/i.test(proposeCancel.result), `result=${proposeCancel.result}`);
    check('5b. the reminder is still scheduled — nothing changed by the mere request', reminderStore.get(created.id)?.status === 'scheduled');

    const confirmCancel = await runTask({ sessionId: SID, goal: 'Confirm', onEvent: () => {}, taskId: nanoid() });
    check('5c. confirming the cancellation transitions the reminder to cancelled', reminderStore.get(created.id)?.status === 'cancelled', `status=${reminderStore.get(created.id)?.status}`);
    check('5d. the confirmation result names the cancelled reminder', confirmCancel.result.toLowerCase().includes('walk the dog'));
    clearAll(SID);
  }

  // ---------- 6. multi-pending clarification — bare Confirm with reminder + calendar both pending ----------
  {
    clearAll(SID);
    await runTask({ sessionId: SID, goal: 'Remind me in 20 minutes to check the oven.', onEvent: () => {}, taskId: nanoid() });
    await runTask({ sessionId: SID, goal: 'Schedule a meeting with Alice tomorrow at 2 PM', onEvent: () => {}, taskId: nanoid() });
    const before = reminderStore.count;
    const r = await runTask({ sessionId: SID, goal: 'Confirm', onEvent: () => {}, taskId: nanoid() });
    check('6. bare "Confirm" with a reminder AND a calendar proposal pending asks which, executes NEITHER', reminderStore.count === before && !!calendarPendingActionStore.active(SID) && !!reminderPendingActionStore.active(SID), `count=${reminderStore.count} calActive=${!!calendarPendingActionStore.active(SID)} remActive=${!!reminderPendingActionStore.active(SID)}`);
    check('6b. the clarification names both pending things', /reminder/i.test(r.result) && /calendar event/i.test(r.result), `result=${r.result}`);
    clearAll(SID);
  }

  // ---------- 6b. same clarification for Tasks + reminder ----------
  {
    clearAll(SID);
    await runTask({ sessionId: SID, goal: 'Remind me in 20 minutes to check the oven.', onEvent: () => {}, taskId: nanoid() });
    await runTask({ sessionId: SID, goal: 'Add a task to buy milk.', onEvent: () => {}, taskId: nanoid() });
    const r = await runTask({ sessionId: SID, goal: 'Confirm', onEvent: () => {}, taskId: nanoid() });
    check('6c. bare "Confirm" with a reminder AND a Tasks proposal pending asks which', /reminder/i.test(r.result) && /task/i.test(r.result), `result=${r.result}`);
    clearAll(SID);
  }

  // ---------- 6c. same clarification for Gmail-send + reminder ----------
  {
    clearAll(SID);
    await runTask({ sessionId: SID, goal: 'Remind me in 20 minutes to check the oven.', onEvent: () => {}, taskId: nanoid() });
    await runTask({ sessionId: SID, goal: 'Draft an email to Priya saying hello.', onEvent: () => {}, taskId: nanoid() });
    const r = await runTask({ sessionId: SID, goal: 'Confirm', onEvent: () => {}, taskId: nanoid() });
    check('6d. bare "Confirm" with a reminder AND a Gmail draft pending asks which', /reminder/i.test(r.result) && /email/i.test(r.result), `result=${r.result}`);
    clearAll(SID);
  }

  // ---------- 7. "Confirm the reminder" → reminder only, even with Tasks also pending ----------
  {
    clearAll(SID);
    await runTask({ sessionId: SID, goal: 'Remind me in 20 minutes to check the oven.', onEvent: () => {}, taskId: nanoid() });
    await runTask({ sessionId: SID, goal: 'Add a task to buy milk.', onEvent: () => {}, taskId: nanoid() });
    const beforeCount = reminderStore.count;
    const r = await runTask({ sessionId: SID, goal: 'Confirm the reminder', onEvent: () => {}, taskId: nanoid() });
    check('7. "Confirm the reminder" creates the reminder specifically', reminderStore.count === beforeCount + 1, `before=${beforeCount} after=${reminderStore.count}`);
    check('7b. "Confirm the reminder" does NOT touch the still-pending Tasks proposal', !!tasksPendingActionStore.active(SID));
    check('7c. the reminder pending action is now cleared', !reminderPendingActionStore.active(SID));
    check('7d. the result is reminder-specific', r.result.toLowerCase().includes('check the oven'), `result=${r.result}`);
    clearAll(SID);
  }

  // ---------- 8. "Confirm the task" → tasks only, even with reminder also pending ----------
  {
    clearAll(SID);
    await runTask({ sessionId: SID, goal: 'Remind me in 20 minutes to check the oven.', onEvent: () => {}, taskId: nanoid() });
    await runTask({ sessionId: SID, goal: 'Add a task to buy milk.', onEvent: () => {}, taskId: nanoid() });
    const r = await runTask({ sessionId: SID, goal: 'Confirm the task', onEvent: () => {}, taskId: nanoid() });
    check('8. "Confirm the task" dispatches to Tasks, not reminders', r.capability?.selected === 'tasks', `capability=${r.capability?.selected}`);
    check('8b. the reminder proposal is STILL pending, untouched', !!reminderPendingActionStore.active(SID));
    clearAll(SID);
  }

  // ---------- 9. "Confirm the meeting" / "Confirm the email" → unaffected by CP29 ----------
  {
    clearAll(SID);
    await runTask({ sessionId: SID, goal: 'Remind me in 20 minutes to check the oven.', onEvent: () => {}, taskId: nanoid() });
    await runTask({ sessionId: SID, goal: 'Schedule a meeting with Alice tomorrow at 2 PM', onEvent: () => {}, taskId: nanoid() });
    const r = await runTask({ sessionId: SID, goal: 'Confirm the meeting', onEvent: () => {}, taskId: nanoid() });
    check('9. "Confirm the meeting" dispatches to Calendar, not reminders — CP18 behavior fully preserved', r.capability?.selected === 'calendar', `capability=${r.capability?.selected}`);
    clearAll(SID);
  }

  // ---------- 10. "Cancel the reminder" → reminder only ----------
  {
    clearAll(SID);
    await runTask({ sessionId: SID, goal: 'Remind me in 20 minutes to check the oven.', onEvent: () => {}, taskId: nanoid() });
    await runTask({ sessionId: SID, goal: 'Add a task to buy milk.', onEvent: () => {}, taskId: nanoid() });
    const before = reminderStore.count;
    const r = await runTask({ sessionId: SID, goal: 'Cancel the reminder', onEvent: () => {}, taskId: nanoid() });
    check('10. "Cancel the reminder" clears only the reminder proposal', !reminderPendingActionStore.active(SID) && !!tasksPendingActionStore.active(SID));
    check('10b. nothing was persisted', reminderStore.count === before);
    check('10c. result names the reminder', /reminder/i.test(r.result), `result=${r.result}`);
    clearAll(SID);
  }

  // ---------- 11. HOLD — "Confirm all"/"Confirm everything"/"Approve
  // all"/"Approve everything" are now deterministically BLOCKED before
  // reaching browser/OmniRoute, in every pending-state combination the
  // HOLD names. No AbortController/real-network technique needed anymore
  // — the phrase is intercepted synchronously, so a real hang is
  // structurally impossible now (proven by the absence of any
  // browser.initialized event AND by the call completing instantly). ----------
  const EXPECTED_BULK_MESSAGE = "I can't confirm multiple pending actions at once. Please specify which action to confirm.";

  // 11a. all four required phrasings, with reminder+Tasks both pending.
  for (const [n, phrase] of [['a', 'Confirm all'], ['b', 'Confirm everything'], ['c', 'Approve all'], ['d', 'Approve everything']] as const) {
    clearAll(SID);
    await runTask({ sessionId: SID, goal: 'Remind me in 20 minutes to check the oven.', onEvent: () => {}, taskId: nanoid() });
    await runTask({ sessionId: SID, goal: 'Add a task to buy milk.', onEvent: () => {}, taskId: nanoid() });
    const before = reminderStore.count;
    const r = await runTask({ sessionId: SID, goal: phrase, onEvent: () => {}, taskId: nanoid() });
    const browserInvoked = r.events.some((e) => e.type === 'browser.initialized');
    check(`11${n}. "${phrase}" is deterministically blocked with the exact required message`, r.result === EXPECTED_BULK_MESSAGE, `result=${r.result}`);
    check(`11${n}b. "${phrase}" never invokes the browser/OmniRoute`, !browserInvoked);
    check(`11${n}c. "${phrase}" mutates nothing`, reminderStore.count === before);
    check(`11${n}d. "${phrase}" claims no confirmation — outcome is blocked, not completed-as-success-claiming-action`, r.outcome === 'blocked');
    check(`11${n}e. "${phrase}" preserves BOTH pending proposals untouched`, !!reminderPendingActionStore.active(SID) && !!tasksPendingActionStore.active(SID));
    clearAll(SID);
  }

  // 11e. exhaustive pending-state matrix for the canonical phrase.
  const pendingScenarios: [string, () => Promise<void>, () => boolean][] = [
    ['reminder-only', async () => { await runTask({ sessionId: SID, goal: 'Remind me in 20 minutes to check the oven.', onEvent: () => {}, taskId: nanoid() }); }, () => !!reminderPendingActionStore.active(SID)],
    ['reminder+calendar', async () => {
      await runTask({ sessionId: SID, goal: 'Remind me in 20 minutes to check the oven.', onEvent: () => {}, taskId: nanoid() });
      await runTask({ sessionId: SID, goal: 'Schedule a meeting with Alice tomorrow at 2 PM', onEvent: () => {}, taskId: nanoid() });
    }, () => !!reminderPendingActionStore.active(SID) && !!calendarPendingActionStore.active(SID)],
    ['reminder+tasks', async () => {
      await runTask({ sessionId: SID, goal: 'Remind me in 20 minutes to check the oven.', onEvent: () => {}, taskId: nanoid() });
      await runTask({ sessionId: SID, goal: 'Add a task to buy milk.', onEvent: () => {}, taskId: nanoid() });
    }, () => !!reminderPendingActionStore.active(SID) && !!tasksPendingActionStore.active(SID)],
    ['reminder+gmail', async () => {
      await runTask({ sessionId: SID, goal: 'Remind me in 20 minutes to check the oven.', onEvent: () => {}, taskId: nanoid() });
      await runTask({ sessionId: SID, goal: 'Draft an email to Priya saying hello.', onEvent: () => {}, taskId: nanoid() });
    }, () => !!reminderPendingActionStore.active(SID) && !!pendingActionStore.active(SID)],
    ['no-pending', async () => {}, () => !reminderPendingActionStore.active(SID) && !calendarPendingActionStore.active(SID) && !tasksPendingActionStore.active(SID) && !pendingActionStore.active(SID)],
  ];
  for (const [label, setup, stillPendingAsExpected] of pendingScenarios) {
    clearAll(SID);
    await setup();
    const before = reminderStore.count;
    const r = await runTask({ sessionId: SID, goal: 'Confirm all', onEvent: () => {}, taskId: nanoid() });
    const browserInvoked = r.events.some((e) => e.type === 'browser.initialized');
    check(`11-matrix-${label}. "Confirm all" is blocked with [${label}] pending`, r.result === EXPECTED_BULK_MESSAGE, `result=${r.result}`);
    check(`11-matrix-${label}b. never reaches the browser, even with ZERO things pending (never becomes an unrestricted planner command)`, !browserInvoked);
    check(`11-matrix-${label}c. mutates nothing`, reminderStore.count === before);
    check(`11-matrix-${label}d. pending state is exactly preserved (or, for no-pending, remains exactly nothing)`, stillPendingAsExpected());
    clearAll(SID);
  }

  // 11f. session isolation is unaffected by the bulk-confirm block.
  {
    clearAll(SID);
    clearAll(SID_B);
    await runTask({ sessionId: SID, goal: 'Remind me in 20 minutes to check the oven.', onEvent: () => {}, taskId: nanoid() });
    const rB = await runTask({ sessionId: SID_B, goal: 'Confirm all', onEvent: () => {}, taskId: nanoid() });
    check('11f. "Confirm all" in session B is blocked exactly the same way even though session B has nothing pending — never leaks/reacts to session A\'s pending reminder', rB.result === EXPECTED_BULK_MESSAGE && !!reminderPendingActionStore.active(SID) && !reminderPendingActionStore.active(SID_B));
    clearAll(SID);
    clearAll(SID_B);
  }
  {
    clearAll(SID);
    await runTask({ sessionId: SID, goal: 'Remind me in 20 minutes to check the oven.', onEvent: () => {}, taskId: nanoid() });
    await runTask({ sessionId: SID, goal: 'Add a task to buy milk.', onEvent: () => {}, taskId: nanoid() });
    const r = await runTask({ sessionId: SID, goal: 'Cancel all', onEvent: () => {}, taskId: nanoid() });
    check('12. "Cancel all" DOES clear a pending reminder proposal along with everything else (reuses the existing cancel-all mechanism, correctly widened)', !reminderPendingActionStore.active(SID) && !tasksPendingActionStore.active(SID));
    check('12b. "Cancel all" names the reminder in its summary', /reminder/i.test(r.result), `result=${r.result}`);
    clearAll(SID);
  }

  // ---------- 13. reject phrase resolves correctly when reminder is the ONLY thing pending (ambiguous-cancel single-active tier) ----------
  {
    clearAll(SID);
    await runTask({ sessionId: SID, goal: 'Remind me in 20 minutes to check the oven.', onEvent: () => {}, taskId: nanoid() });
    const r = await runTask({ sessionId: SID, goal: 'Never mind', onEvent: () => {}, taskId: nanoid() });
    check('13. "Never mind" with only a reminder pending cancels it specifically', !reminderPendingActionStore.active(SID) && /reminder/i.test(r.result), `result=${r.result}`);
    clearAll(SID);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  try { require('fs').rmSync(TEST_PREFS_PATH, { force: true }); require('fs').rmSync(TEST_REMINDERS_PATH, { force: true }); } catch {}
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error('Fatal error:', e);
  try { require('fs').rmSync(TEST_PREFS_PATH, { force: true }); require('fs').rmSync(TEST_REMINDERS_PATH, { force: true }); } catch {}
  process.exit(1);
});
