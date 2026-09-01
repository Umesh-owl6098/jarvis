/**
 * CP24 follow-up investigation — pending-slot interruption semantics and a
 * consolidated cancellation matrix (slots crossed with real PendingActions).
 *
 * Not a re-test of the 63 already-passing CP24 assertions in
 * test-cp24-gmail-slot.ts / test-cp24-calendar-slot.ts — this file exists
 * specifically to make explicit, and prove, three things those files only
 * implied:
 *
 *   1. An interrupting command does NOT clear the original slot — it is
 *      left active (not consumed) so a later turn can still answer the
 *      original question within its TTL. This is deliberate, documented
 *      behavior, not an oversight.
 *   2. A SECOND "email <person>" while a gmail_draft_body slot is already
 *      active REPLACES the slot's recipient — a safety-critical guarantee
 *      that a stale slot can never leak a later body to an earlier,
 *      already-superseded recipient.
 *   3. The cancellation matrix across every slot/real-PendingAction
 *      combination behaves exactly as documented — including the one gap
 *      this investigation exists to close: "Cancel all" now also clears an
 *      active conversational slot (see task-manager.ts's isCancelAllPhrase
 *      block).
 */
const TEST_PREFS_PATH = require('os').tmpdir() + '/jarvis-cp24-interruption-cancellation-' + Date.now() + '.json';
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
  pendingSlotStore.clear(sid);
}

async function main() {
  clearAllPending(SID);
  clearAllPending(SID_B);

  // ==========================================================
  // §3a — interruption does not clear the slot; a later bare answer still
  // completes the ORIGINAL question. Documented, not a bug.
  // ==========================================================
  {
    const t1 = await runTask({ sessionId: SID, goal: 'email Alice', onEvent: () => {}, taskId: nanoid() });
    check('3a-1. "email Alice" — clarification, slot active', t1.result === 'What would you like the email to say?' && pendingSlotStore.active(SID)?.kind === 'gmail_draft_body');

    const t2 = await runTask({ sessionId: SID, goal: 'What is on my calendar today?', onEvent: () => {}, taskId: nanoid() });
    check('3a-2. interrupting Calendar command executes normally', t2.capability?.selected === 'calendar' && !/DRAFT CREATED/.test(t2.result));
    check(
      '3a-3. DOCUMENTED BEHAVIOR — the Gmail slot survives the interruption (not cleared, not consumed) — this is intentional so a later turn can still answer the original question within the TTL',
      pendingSlotStore.active(SID)?.kind === 'gmail_draft_body' &&
        (pendingSlotStore.active(SID) as any).recipients?.[0] === 'alice@example.com'
    );

    const t3 = await runTask({ sessionId: SID, goal: "I'll be there at 4", onEvent: () => {}, taskId: nanoid() });
    check(
      '3a-4. DOCUMENTED BEHAVIOR — the later bare answer completes the SURVIVING slot: a real draft is created to Alice (the original, pre-interruption recipient), not dropped and not sent to the interrupting Calendar command',
      /DRAFT CREATED/.test(t3.result) && /alice@example\.com/.test(t3.result),
      `result=${t3.result}`
    );
    clearAllPending(SID);
  }

  // ==========================================================
  // §3b — SAFETY-CRITICAL: a second "email <person>" while a slot is
  // already active must REPLACE the recipient, never let a stale slot's
  // OLD recipient leak the NEW body.
  // ==========================================================
  {
    const t1 = await runTask({ sessionId: SID, goal: 'email Alice', onEvent: () => {}, taskId: nanoid() });
    check('3b-1. "email Alice" — slot created for Alice', (pendingSlotStore.active(SID) as any)?.recipients?.[0] === 'alice@example.com', `result=${t1.result}`);

    const t2 = await runTask({ sessionId: SID, goal: 'email Priya', onEvent: () => {}, taskId: nanoid() });
    check('3b-2. "email Priya" — a NEW clarification, not swallowed as Alice\'s body', t2.result === 'What would you like the email to say?' && t2.resolution?.email === 'priya.work@example.com', `result=${t2.result} resolution=${JSON.stringify(t2.resolution)}`);
    check(
      '3b-3. SAFETY — the slot now holds Priya, NOT Alice — the old recipient was replaced, not appended or left dangling',
      (pendingSlotStore.active(SID) as any)?.recipients?.length === 1 && (pendingSlotStore.active(SID) as any)?.recipients?.[0] === 'priya.work@example.com',
      `slot=${JSON.stringify(pendingSlotStore.active(SID))}`
    );

    const t3 = await runTask({ sessionId: SID, goal: "Tell her I'll call tomorrow.", onEvent: () => {}, taskId: nanoid() });
    check(
      '3b-4. SAFETY — the body goes to Priya (the current, replaced recipient), and alice@example.com never appears anywhere in the draft',
      /DRAFT CREATED/.test(t3.result) && /priya\.work@example\.com/.test(t3.result) && !/alice@example\.com/.test(t3.result),
      `result=${t3.result}`
    );
    clearAllPending(SID);
  }

  // ==========================================================
  // §4 — cancellation matrix
  // ==========================================================

  // 4a. Gmail body slot ONLY + "Cancel it." -> slot cleared.
  {
    clearAllPending(SID);
    await runTask({ sessionId: SID, goal: 'email Alice', onEvent: () => {}, taskId: nanoid() });
    check('4a-setup. gmail slot active, nothing else pending', !!pendingSlotStore.active(SID) && !pendingActionStore.active(SID) && !calendarPendingActionStore.active(SID) && !tasksPendingActionStore.active(SID));
    const r = await runTask({ sessionId: SID, goal: 'Cancel it.', onEvent: () => {}, taskId: nanoid() });
    check('4a. Gmail slot only + "Cancel it." -> slot cleared, no draft', !pendingSlotStore.active(SID) && !/DRAFT CREATED/.test(r.result), `result=${r.result}`);
    clearAllPending(SID);
  }

  // 4b. Calendar datetime slot ONLY + "Cancel it." -> slot cleared.
  {
    clearAllPending(SID);
    await runTask({ sessionId: SID, goal: 'Schedule a meeting with Alice', onEvent: () => {}, taskId: nanoid() });
    check('4b-setup. calendar slot active, nothing else pending', !!pendingSlotStore.active(SID) && !pendingActionStore.active(SID) && !calendarPendingActionStore.active(SID) && !tasksPendingActionStore.active(SID));
    const r = await runTask({ sessionId: SID, goal: 'Cancel it.', onEvent: () => {}, taskId: nanoid() });
    check('4b. Calendar slot only + "Cancel it." -> slot cleared, no proposal', !pendingSlotStore.active(SID) && !/EVENT READY FOR CONFIRMATION/.test(r.result), `result=${r.result}`);
    clearAllPending(SID);
  }

  // 4c. Gmail slot + ONE real (different-capability) pending action + "Cancel it."
  //     -> the existing "exactly one real pending action" tiebreak claims
  //     it deterministically for that ONE real action; the slot (not a
  //     PendingAction) is untouched by a bare "Cancel it." — documented,
  //     not a bug: "Cancel it" binds to the one thing that was just
  //     proposed and needs a yes/no, not to a separate still-open
  //     question. No mutation risk either way (drafting/proposing were
  //     already non-gated/non-mutating).
  {
    clearAllPending(SID);
    await runTask({ sessionId: SID, goal: 'Schedule a meeting with Alice tomorrow at 2 PM', onEvent: () => {}, taskId: nanoid() });
    await runTask({ sessionId: SID, goal: 'email Priya', onEvent: () => {}, taskId: nanoid() });
    check('4c-setup. one real Calendar pending action AND one Gmail slot, simultaneously', !!calendarPendingActionStore.active(SID) && !!pendingSlotStore.active(SID) && !pendingActionStore.active(SID) && !tasksPendingActionStore.active(SID));
    const r = await runTask({ sessionId: SID, goal: 'Cancel it.', onEvent: () => {}, taskId: nanoid() });
    check('4c. "Cancel it." unambiguously cancels the ONE real pending action (Calendar)', !calendarPendingActionStore.active(SID) && /calendar change was not made/i.test(r.result), `result=${r.result}`);
    check(
      '4c. DOCUMENTED — the Gmail slot (not a PendingAction) is left untouched by a bare "Cancel it." when exactly one real pending action exists elsewhere — no unsafe ambiguity, no wrong cancellation: the Calendar action was the only thing that needed a yes/no',
      !!pendingSlotStore.active(SID)
    );
    clearAllPending(SID);
  }

  // 4d. Gmail slot + MULTIPLE real pending actions (different capabilities)
  //     + "Cancel it." -> existing multi-pending ambiguous-cancel
  //     clarification is completely unaffected by CP24.
  {
    clearAllPending(SID);
    await runTask({ sessionId: SID, goal: 'Schedule a meeting with Alice tomorrow at 2 PM', onEvent: () => {}, taskId: nanoid() });
    await runTask({ sessionId: SID, goal: 'create a task to call Priya tomorrow', onEvent: () => {}, taskId: nanoid() });
    await runTask({ sessionId: SID, goal: 'email Priya', onEvent: () => {}, taskId: nanoid() });
    check('4d-setup. real Calendar pending, real Tasks pending, AND a Gmail slot, all simultaneously', !!calendarPendingActionStore.active(SID) && !!tasksPendingActionStore.active(SID) && !!pendingSlotStore.active(SID));
    const r = await runTask({ sessionId: SID, goal: 'Cancel it.', onEvent: () => {}, taskId: nanoid() });
    check(
      '4d. multi-pending ambiguous-cancel clarification preserved EXACTLY — "which should I cancel?", nothing cancelled yet',
      /pending Calendar action/i.test(r.result) && /pending Tasks action/i.test(r.result) && /which should i cancel/i.test(r.result) && !!calendarPendingActionStore.active(SID) && !!tasksPendingActionStore.active(SID),
      `result=${r.result}`
    );
    check('4d. the Gmail slot is untouched by the ambiguous-cancel clarification (nothing was actually cancelled yet)', !!pendingSlotStore.active(SID));
    clearAllPending(SID);
  }

  // 4e. "Cancel all" with a slot + real pending action(s) -> clears
  //     EVERYTHING, including the conversational slot.
  {
    clearAllPending(SID);
    await runTask({ sessionId: SID, goal: 'Schedule a meeting with Alice tomorrow at 2 PM', onEvent: () => {}, taskId: nanoid() });
    await runTask({ sessionId: SID, goal: 'email Priya', onEvent: () => {}, taskId: nanoid() });
    check('4e-setup. one real Calendar pending action AND one Gmail slot', !!calendarPendingActionStore.active(SID) && !!pendingSlotStore.active(SID));
    const r = await runTask({ sessionId: SID, goal: 'Cancel all.', onEvent: () => {}, taskId: nanoid() });
    check('4e. "Cancel all." clears the real Calendar pending action', !calendarPendingActionStore.active(SID), `result=${r.result}`);
    check('4e. "Cancel all." ALSO clears the conversational slot', !pendingSlotStore.active(SID), `result=${r.result}`);
    clearAllPending(SID);
  }

  // 4f. "Cancel all" with ONLY a slot active (no real pending actions at
  //     all) -> still clears the slot and reports success, rather than
  //     falling through to browser/unclassified routing.
  {
    clearAllPending(SID);
    await runTask({ sessionId: SID, goal: 'email Priya', onEvent: () => {}, taskId: nanoid() });
    check('4f-setup. only a Gmail slot active, nothing real pending', !!pendingSlotStore.active(SID) && !pendingActionStore.active(SID) && !calendarPendingActionStore.active(SID) && !tasksPendingActionStore.active(SID));
    const r = await runTask({ sessionId: SID, goal: 'Cancel all.', onEvent: () => {}, taskId: nanoid() });
    check('4f. "Cancel all." with only a slot pending still clears it and reports success (not routed to browser)', !pendingSlotStore.active(SID) && r.capability?.selected !== 'browser', `capability=${r.capability?.selected} result=${r.result}`);
    clearAllPending(SID);
  }

  // 4g. Session isolation for the cancellation paths above.
  {
    clearAllPending(SID);
    clearAllPending(SID_B);
    await runTask({ sessionId: SID, goal: 'email Priya', onEvent: () => {}, taskId: nanoid() });
    await runTask({ sessionId: SID, goal: 'Schedule a meeting with Alice tomorrow at 2 PM', onEvent: () => {}, taskId: nanoid() });
    check('4g-setup. Session A has a slot + a real pending action, Session B has neither', !!pendingSlotStore.active(SID) && !!calendarPendingActionStore.active(SID) && !pendingSlotStore.active(SID_B) && !calendarPendingActionStore.active(SID_B));
    await runTask({ sessionId: SID_B, goal: 'Cancel all.', onEvent: () => {}, taskId: nanoid() });
    check('4g. Session B\'s "Cancel all." does not touch Session A\'s slot or real pending action', !!pendingSlotStore.active(SID) && !!calendarPendingActionStore.active(SID));
    await runTask({ sessionId: SID_B, goal: 'Cancel it.', onEvent: () => {}, taskId: nanoid() });
    check('4g. Session B\'s "Cancel it." also does not touch Session A\'s state', !!pendingSlotStore.active(SID) && !!calendarPendingActionStore.active(SID));
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
