/**
 * Checkpoint 24 §Gmail — pending conversational slot (gmail_draft_body).
 *
 * Target experience: "email Alice" resolves the recipient and asks "What
 * would you like the email to say?"; the user's very next raw turn
 * ("Tell him I'll be there at 4.") is interpreted as the missing body
 * ONLY because a gmail_draft_body slot is active for this session — see
 * pending-slot.ts and task-manager.ts's attemptPendingSlotCompletion.
 *
 * A pending slot is NOT authorization: drafting is already a non-gated
 * Gmail capability (see gmail/runner.ts's module comment), but "Send it."
 * after the draft is created must still go through the existing, entirely
 * unmodified pendingActionStore confirmation gate (test 14).
 */
const TEST_PREFS_PATH = require('os').tmpdir() + '/jarvis-cp24-gmail-slot-' + Date.now() + '.json';
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
import { extractFollowUpEmailBody } from '@/core/capabilities/gmail/intent';
import type { ExecutionResult } from '@/core/agent/executor';
import { nanoid } from 'nanoid';
import { readFileSync } from 'fs';

const SID = 'test-session-a';
const SID_B = 'test-session-b';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

function browserWasInvoked(r: ExecutionResult): boolean {
  return r.events.some((e) => e.type === 'browser.initialized');
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

  // ---------- 1. "email Alice" -> asks for body, no draft yet, slot created ----------
  {
    const r = await runTask({ sessionId: SID, goal: 'email Alice', onEvent: () => {}, taskId: nanoid() });
    check(
      '1. "email Alice" — asks what the email should say, no draft created, no browser',
      r.capability?.selected === 'gmail' &&
        r.result === 'What would you like the email to say?' &&
        r.resolution?.status === 'resolved' &&
        !r.gmail?.pendingAction &&
        !pendingActionStore.active(SID) &&
        !browserWasInvoked(r),
      `result=${r.result} resolution=${JSON.stringify(r.resolution)}`
    );
    check('1b. a gmail_draft_body slot is now active for this session', pendingSlotStore.active(SID)?.kind === 'gmail_draft_body');
  }

  // ---------- 2. "Tell him I'll be there at 4." -> completes the slot, one draft created ----------
  {
    const r = await runTask({ sessionId: SID, goal: "Tell him I'll be there at 4.", onEvent: () => {}, taskId: nanoid() });
    check(
      "2. \"Tell him I'll be there at 4.\" — completes the pending slot: draft created to alice@example.com, body preserved, no browser",
      r.capability?.selected === 'gmail' &&
        /DRAFT CREATED/.test(r.result) &&
        /alice@example\.com/.test(r.result) &&
        /I'll be there at 4/.test(r.result) &&
        !!r.gmail?.pendingAction &&
        !browserWasInvoked(r),
      `result=${r.result}`
    );
    check('2b. slot is cleared after completion', !pendingSlotStore.active(SID));
    check('2c. a real Gmail send confirmation is now pending', !!pendingActionStore.active(SID));
    clearAllPending(SID);
  }

  // ---------- 3. plain "I'll be there at 4." (no "tell him" wrapper) -> also completes the slot ----------
  {
    const first = await runTask({ sessionId: SID, goal: 'email Alice', onEvent: () => {}, taskId: nanoid() });
    check('3a. setup — clarification slot active', pendingSlotStore.active(SID)?.kind === 'gmail_draft_body', `result=${first.result}`);
    const r = await runTask({ sessionId: SID, goal: "I'll be there at 4.", onEvent: () => {}, taskId: nanoid() });
    check(
      '3. plain "I\'ll be there at 4." with no conversational wrapper — still completes the slot, one draft created, body preserved verbatim',
      r.capability?.selected === 'gmail' && /DRAFT CREATED/.test(r.result) && /I'll be there at 4/.test(r.result) && !!r.gmail?.pendingAction,
      `result=${r.result}`
    );
    clearAllPending(SID);
  }

  // ---------- 4. "Cancel it" after clarification -> no draft, slot cleared ----------
  {
    await runTask({ sessionId: SID, goal: 'email Alice', onEvent: () => {}, taskId: nanoid() });
    check('4a. setup — slot active', !!pendingSlotStore.active(SID));
    const r = await runTask({ sessionId: SID, goal: 'Cancel it.', onEvent: () => {}, taskId: nanoid() });
    check(
      '4. "Cancel it." during clarification — no draft created, honest cancellation message, no browser',
      !/DRAFT CREATED/.test(r.result) && !pendingActionStore.active(SID) && !browserWasInvoked(r),
      `result=${r.result}`
    );
    check('4b. slot cleared by the cancellation', !pendingSlotStore.active(SID));
    clearAllPending(SID);
  }

  // ---------- 5. "Start over" after clarification -> no draft, slot cleared ----------
  {
    await runTask({ sessionId: SID, goal: 'email Alice', onEvent: () => {}, taskId: nanoid() });
    check('5a. setup — slot active', !!pendingSlotStore.active(SID));
    const r = await runTask({ sessionId: SID, goal: 'Start over.', onEvent: () => {}, taskId: nanoid() });
    check('5. "Start over." during clarification — clears context, no draft created', !/DRAFT CREATED/.test(r.result) && !pendingActionStore.active(SID));
    check('5b. slot cleared by start-over', !pendingSlotStore.active(SID));
    clearAllPending(SID);
  }

  // ---------- 6. expired slot -> follow-up does not create a draft ----------
  {
    pendingSlotStore.__setForTesting(SID, {
      kind: 'gmail_draft_body',
      recipients: ['alice@example.com'],
      createdAt: Date.now() - 11 * 60 * 1000, // 11 minutes ago, past the 10-minute TTL
    });
    const r = await runTask({ sessionId: SID, goal: "Tell him I'll be there at 4.", onEvent: () => {}, taskId: nanoid() });
    check(
      '6. expired slot (11 min old) — the follow-up is NOT treated as a body, no draft created',
      !/DRAFT CREATED/.test(r.result),
      `result=${r.result} capability=${r.capability?.selected}`
    );
    check('6b. expired slot reports as inactive', !pendingSlotStore.active(SID));
    clearAllPending(SID);
  }

  // ---------- 7. session isolation — Session B cannot complete Session A's pending body ----------
  {
    clearAllPending(SID);
    clearAllPending(SID_B);
    await runTask({ sessionId: SID, goal: 'email Alice', onEvent: () => {}, taskId: nanoid() });
    check('7a. setup — Session A has an active slot, Session B does not', !!pendingSlotStore.active(SID) && !pendingSlotStore.active(SID_B));
    const r = await runTask({ sessionId: SID_B, goal: "Tell him I'll be there at 4.", onEvent: () => {}, taskId: nanoid() });
    check(
      '7. Session B\'s identical follow-up text does NOT complete Session A\'s pending slot — no draft created for Session B',
      !/DRAFT CREATED/.test(r.result),
      `result=${r.result}`
    );
    check('7b. Session A\'s slot is untouched by Session B\'s turn', !!pendingSlotStore.active(SID));
    clearAllPending(SID);
    clearAllPending(SID_B);
  }

  // ---------- 8. ambiguous contact -> no slot created ----------
  {
    clearAllPending(SID);
    const r = await runTask({ sessionId: SID, goal: 'email John', onEvent: () => {}, taskId: nanoid() });
    check('8. "email John" (ambiguous — two John Smith contacts) — blocked, asks which one', r.capability?.selected === 'gmail' && r.outcome === 'blocked', `result=${r.result}`);
    check('8b. no gmail_draft_body slot created for an ambiguous contact', !pendingSlotStore.active(SID));
    clearAllPending(SID);
  }

  // ---------- 9. unknown contact -> no slot created ----------
  {
    clearAllPending(SID);
    const r = await runTask({ sessionId: SID, goal: 'email Zzznobody', onEvent: () => {}, taskId: nanoid() });
    check('9. "email Zzznobody" (no matching contact) — blocked, does not invent a recipient', r.capability?.selected === 'gmail' && r.outcome === 'blocked', `result=${r.result}`);
    check('9b. no gmail_draft_body slot created for an unresolved contact', !pendingSlotStore.active(SID));
    clearAllPending(SID);
  }

  // ---------- 10. active Gmail slot + an explicit new Calendar command -> Calendar read, no draft, slot untouched ----------
  {
    clearAllPending(SID);
    await runTask({ sessionId: SID, goal: 'email Alice', onEvent: () => {}, taskId: nanoid() });
    check('10a. setup — slot active', !!pendingSlotStore.active(SID));
    const r = await runTask({ sessionId: SID, goal: 'What is on my calendar today?', onEvent: () => {}, taskId: nanoid() });
    check(
      '10. an explicit, complete Calendar command interrupts an active Gmail slot — Calendar read executes, no draft created',
      r.capability?.selected === 'calendar' && !/DRAFT CREATED/.test(r.result),
      `capability=${r.capability?.selected} result=${r.result?.slice(0, 100)}`
    );
    clearAllPending(SID);
  }

  // ---------- 11. active Gmail slot + an explicit new Tasks command -> Tasks proposal, no draft, slot untouched ----------
  {
    clearAllPending(SID);
    await runTask({ sessionId: SID, goal: 'email Alice', onEvent: () => {}, taskId: nanoid() });
    check('11a. setup — slot active', !!pendingSlotStore.active(SID));
    const r = await runTask({ sessionId: SID, goal: 'create a task to call Alice tomorrow', onEvent: () => {}, taskId: nanoid() });
    check(
      '11. an explicit, complete Tasks command interrupts an active Gmail slot — Tasks proposal created, no draft created',
      r.capability?.selected === 'tasks' && !/DRAFT CREATED/.test(r.result) && !!r.tasks?.pendingAction,
      `capability=${r.capability?.selected} result=${r.result?.slice(0, 100)}`
    );
    clearAllPending(SID);
  }

  // ---------- 12. second follow-up after draft completion does not reuse the cleared slot ----------
  {
    clearAllPending(SID);
    await runTask({ sessionId: SID, goal: 'email Alice', onEvent: () => {}, taskId: nanoid() });
    const first = await runTask({ sessionId: SID, goal: "Tell him I'll be there at 4.", onEvent: () => {}, taskId: nanoid() });
    check('12a. setup — first follow-up created a draft and cleared the slot', /DRAFT CREATED/.test(first.result) && !pendingSlotStore.active(SID));
    const second = await runTask({ sessionId: SID, goal: 'Running 10 minutes late.', onEvent: () => {}, taskId: nanoid() });
    check(
      '12. a second follow-up after the slot was already consumed does NOT create another draft from the stale slot',
      !/DRAFT CREATED/.test(second.result),
      `result=${second.result}`
    );
    clearAllPending(SID);
  }

  // ---------- 13. retrieved/untrusted content structurally cannot fill the slot ----------
  {
    const runnerFiles = [
      'src/core/capabilities/gmail/runner.ts',
      'src/core/capabilities/calendar/runner.ts',
      'src/core/capabilities/tasks/runner.ts',
    ];
    let anyRunnerTouchesSlotStore = false;
    for (const f of runnerFiles) {
      const src = readFileSync(f, 'utf-8');
      if (src.includes('pending-slot') || src.includes('pendingSlotStore')) anyRunnerTouchesSlotStore = true;
    }
    check(
      '13. no capability runner (which processes RETRIEVED Gmail/Calendar/Tasks content) ever imports or touches pendingSlotStore — only task-manager.ts/pending-slot-resolver.ts (on the raw user command) may set/clear a slot',
      !anyRunnerTouchesSlotStore
    );
    // Checkpoint 24 architecture review — slot CREATION/COMPLETION logic
    // lives in pending-slot-resolver.ts (recordGmailDraftBodySlot/
    // recordCalendarDatetimeSlot/attemptPendingSlotCompletion); task-
    // manager.ts only ever calls .active()/.clear()/.pruneAllExpired() for
    // its own routing/precedence decisions (start-over, the shared-reject-
    // word deferral, "Cancel all"). Together these two files are the sole
    // callers of pendingSlotStore.set — no runner, no other module.
    const taskManagerSrc = readFileSync('src/core/agent/task-manager.ts', 'utf-8');
    const resolverSrc = readFileSync('src/core/agent/pending-slot-resolver.ts', 'utf-8');
    check(
      '13b. pending-slot-resolver.ts is the actual caller of pendingSlotStore.set (slot creation/completion), and task-manager.ts still owns pendingSlotStore.clear (precedence/lifecycle decisions: start-over, cancellation)',
      resolverSrc.includes('pendingSlotStore.set') && taskManagerSrc.includes('pendingSlotStore.clear')
    );
  }

  // ---------- 14. "Send it." after draft creation still uses the existing, unmodified confirmation gate ----------
  {
    clearAllPending(SID);
    await runTask({ sessionId: SID, goal: 'email Alice', onEvent: () => {}, taskId: nanoid() });
    const drafted = await runTask({ sessionId: SID, goal: "Tell him I'll be there at 4.", onEvent: () => {}, taskId: nanoid() });
    check('14a. setup — draft created, real send confirmation pending', /DRAFT CREATED/.test(drafted.result) && !!pendingActionStore.active(SID));
    const sent = await runTask({ sessionId: SID, goal: 'Send it.', onEvent: () => {}, taskId: nanoid() });
    check(
      '14. "Send it." after the slot-completed draft still goes through the EXISTING Gmail send confirmation gate and actually sends',
      /^Sent email to/.test(sent.result) && !!sent.gmail?.sentMessageId,
      `result=${sent.result}`
    );
    check('14b. pending send action consumed (claimed), nothing left pending', !pendingActionStore.active(SID));
    clearAllPending(SID);
  }

  // ---------- Preservation: "email Alice" with nothing else happening never touches browser/OmniRoute and never creates an empty draft ----------
  {
    clearAllPending(SID);
    const r = await runTask({ sessionId: SID, goal: 'email Alice', onEvent: () => {}, taskId: nanoid() });
    check('Preservation — "email Alice" alone: no browser, no empty draft', !browserWasInvoked(r) && !pendingActionStore.active(SID));
    clearAllPending(SID);
  }

  // ---------- Deterministic body-extraction unit checks ----------
  {
    check('extractFollowUpEmailBody strips "tell him"', extractFollowUpEmailBody("Tell him I'll be there at 4") === "I'll be there at 4");
    check('extractFollowUpEmailBody strips "tell her"', extractFollowUpEmailBody("Tell her I'm running late") === "I'm running late");
    check('extractFollowUpEmailBody strips "say"', extractFollowUpEmailBody("Say I'll call tomorrow") === "I'll call tomorrow");
    check('extractFollowUpEmailBody preserves bare text with no wrapper', extractFollowUpEmailBody("I'll be there at 4") === "I'll be there at 4");
    check('extractFollowUpEmailBody preserves bare text with no wrapper (2)', extractFollowUpEmailBody('Running 10 minutes late') === 'Running 10 minutes late');
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
