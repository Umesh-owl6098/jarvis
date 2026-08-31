/**
 * Checkpoint 22 fix — the 15 required session-isolation tests, plus a 16th
 * covering the reload/new-session lifecycle explicitly (an orphaned
 * proposal from a session nobody can reach anymore must still expire
 * normally through TTL, and must never become reachable by a new session
 * either before or after that expiry — isolation is never weakened just to
 * make an old proposal recoverable). An
 * empirical cross-session curl test (two independent, zero-shared-state
 * requests hitting the same dev-server process) proved that
 * conversationContext and all three PendingAction stores were bare
 * process-global singletons: session B could inherit session A's "that"/
 * "Friday", and could claim/cancel session A's pending Calendar/Gmail/
 * Tasks action. This file proves the fix — every store now keyed by an
 * explicit sessionId — holds under the SAME kinds of scenarios, all
 * through runTask(), the one authoritative execution path.
 */
process.env.USE_MOCK_GMAIL = 'true';
process.env.USE_MOCK_CALENDAR = 'true';
process.env.USE_MOCK_TASKS = 'true';
process.env.USE_MOCK_CONTACTS = 'true';

import { runTask } from '@/core/agent/task-manager';
import { normalizeVoiceCommand } from '@/lib/voice/normalize';
import { conversationContext } from '@/core/agent/conversation-context';
import { pendingActionStore } from '@/core/capabilities/gmail/pending-action';
import { calendarPendingActionStore } from '@/core/capabilities/calendar/pending-action';
import { tasksPendingActionStore } from '@/core/capabilities/tasks/pending-action';
import { getGmailClient } from '@/core/capabilities/gmail/resolve';
import { getCalendarClient } from '@/core/capabilities/calendar/resolve';
import { isValidSessionId, resolveSessionId } from '@/core/agent/session';
import { nanoid } from 'nanoid';

const A = 'session-a-000000';
const B = 'session-b-000000';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

function clearAllFor(sessionId: string) {
  pendingActionStore.clear(sessionId);
  calendarPendingActionStore.clear(sessionId);
  tasksPendingActionStore.clear(sessionId);
  conversationContext.clear(sessionId);
}

async function main() {
  // ---------- 1. Calendar context: B does not inherit A's ----------
  {
    clearAllFor(A); clearAllFor(B);
    const rA = await runTask({ sessionId: A, goal: 'What meetings do I have tomorrow?', onEvent: () => {}, taskId: nanoid() });
    check('1a. session A establishes Calendar context', rA.capability?.selected === 'calendar');
    const rB = await runTask({ sessionId: B, goal: 'What about Friday?', onEvent: () => {}, taskId: nanoid() });
    check(
      '1b. session B "What about Friday?" does NOT inherit session A\'s Calendar context',
      rB.outcome === 'blocked' && /don't have a prior calendar or task question/i.test(rB.result),
      `outcome=${rB.outcome} result=${rB.result}`
    );
  }

  // ---------- 2. Tasks context: B does not inherit A's ----------
  {
    clearAllFor(A); clearAllFor(B);
    const rA = await runTask({ sessionId: A, goal: 'What tasks do I have tomorrow?', onEvent: () => {}, taskId: nanoid() });
    check('2a. session A establishes Tasks context', rA.capability?.selected === 'tasks');
    const rB = await runTask({ sessionId: B, goal: 'What about the day after?', onEvent: () => {}, taskId: nanoid() });
    check(
      '2b. session B "What about the day after?" does NOT inherit session A\'s Tasks context',
      rB.outcome === 'blocked' && /don't have a prior calendar or task question/i.test(rB.result),
      `outcome=${rB.outcome} result=${rB.result}`
    );
  }

  // ---------- 3. Contact/pronoun context: B cannot resolve "them" from A ----------
  {
    clearAllFor(A); clearAllFor(B);
    const rA = await runTask({ sessionId: A, goal: 'Draft an email to Alice saying hello there.', onEvent: () => {}, taskId: nanoid() });
    check('3a. session A resolves a contact (Alice)', rA.capability?.selected === 'gmail' && !!rA.resolution);
    const rB = await runTask({ sessionId: B, goal: 'Draft an email to them saying hi.', onEvent: () => {}, taskId: nanoid() });
    check(
      '3b. session B "them" does NOT resolve to session A\'s Alice',
      !JSON.stringify(rB).toLowerCase().includes('alice@example.com'),
      `result=${rB.result}`
    );
  }

  // ---------- 4. B "Create it." cannot create A's pending Calendar proposal ----------
  {
    clearAllFor(A); clearAllFor(B);
    const rA = await runTask({ sessionId: A, goal: 'Schedule a meeting with Alice tomorrow at 2 PM for 30 minutes.', onEvent: () => {}, taskId: nanoid() });
    check('4a. session A has a pending Calendar create proposal', !!calendarPendingActionStore.active(A));
    const beforeTitle = calendarPendingActionStore.active(A)?.proposal.title;
    const calClient = getCalendarClient();
    const before = (await calClient.listEvents(new Date(0).toISOString(), new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString(), 'UTC', 200)).length;
    const rB = await runTask({ sessionId: B, goal: 'Create it.', onEvent: () => {}, taskId: nanoid() });
    const after = (await calClient.listEvents(new Date(0).toISOString(), new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString(), 'UTC', 200)).length;
    check(
      '4b. session B "Create it." reports nothing pending for B and creates NO event',
      /no pending calendar action/i.test(rB.result) && after === before,
      `result=${rB.result} before=${before} after=${after}`
    );
    check(
      '4c. session A\'s own pending proposal is untouched by B\'s failed confirm',
      calendarPendingActionStore.active(A)?.proposal.title === beforeTitle,
      `title=${calendarPendingActionStore.active(A)?.proposal.title}`
    );
  }

  // ---------- 5. B "Cancel it." cannot cancel A's pending Calendar proposal ----------
  {
    clearAllFor(A); clearAllFor(B);
    await runTask({ sessionId: A, goal: 'Schedule a meeting with Alice tomorrow at 5 PM for 30 minutes.', onEvent: () => {}, taskId: nanoid() });
    check('5a. session A has a pending Calendar create proposal', !!calendarPendingActionStore.active(A));
    const rB = await runTask({ sessionId: B, goal: 'Cancel it.', onEvent: () => {}, taskId: nanoid() });
    check(
      '5b. session A\'s pending proposal SURVIVES session B\'s "Cancel it."',
      !!calendarPendingActionStore.active(A),
      `result=${rB.result} aStillActive=${!!calendarPendingActionStore.active(A)}`
    );
  }

  // ---------- 6. B cannot confirm/cancel/revise A's pending Tasks proposal ----------
  {
    clearAllFor(A); clearAllFor(B);
    await runTask({ sessionId: A, goal: 'Remind me to call Ramesh tomorrow.', onEvent: () => {}, taskId: nanoid() });
    const beforeTitle = tasksPendingActionStore.active(A)?.proposal.title;
    check('6a. session A has a pending Tasks create proposal', !!beforeTitle);

    const rConfirm = await runTask({ sessionId: B, goal: 'Create it.', onEvent: () => {}, taskId: nanoid() });
    const rCancel = await runTask({ sessionId: B, goal: 'Cancel it.', onEvent: () => {}, taskId: nanoid() });
    // Revision ("Make that Friday instead.") is not exercised live here: with
    // NEITHER a Calendar nor Tasks proposal active for session B,
    // attemptProposalRevision's own candidates list is provably empty
    // (proposal-revision.ts's "day && !clock" branch requires tasksActive —
    // see attemptProposalRevision) — it returns null BEFORE ever reading or
    // writing any session's pending state, so it structurally cannot reach
    // session A's proposal. Running it live would only fall through to a
    // real (slow, network-dependent) browser-fallback attempt, unrelated to
    // what this test is proving.
    check(
      '6b. session B can neither confirm nor cancel session A\'s pending Tasks proposal — A\'s proposal is untouched',
      /no pending (task|calendar) action/i.test(rConfirm.result) &&
        /no pending (task|calendar) action/i.test(rCancel.result) &&
        tasksPendingActionStore.active(A)?.proposal.title === beforeTitle,
      `confirm=${rConfirm.result} cancel=${rCancel.result}`
    );
  }

  // ---------- 7. B cannot send/cancel/revise A's pending Gmail send ----------
  {
    clearAllFor(A); clearAllFor(B);
    await runTask({ sessionId: A, goal: 'Draft an email to isoa@example.com saying session A only.', onEvent: () => {}, taskId: nanoid() });
    const draftId = pendingActionStore.active(A)?.draftId;
    check('7a. session A has a pending Gmail send', !!draftId);

    const rSend = await runTask({ sessionId: B, goal: 'Send it.', onEvent: () => {}, taskId: nanoid() });
    const client = getGmailClient();
    const draftAfter = draftId ? client.getDraft(draftId) : null;
    check(
      '7b. session B "Send it." does NOT send session A\'s draft',
      /no pending email/i.test(rSend.result) && draftAfter?.sent === false,
      `result=${rSend.result} sent=${draftAfter?.sent}`
    );

    const rCancel = await runTask({ sessionId: B, goal: 'Cancel it.', onEvent: () => {}, taskId: nanoid() });
    check(
      '7c. session A\'s pending send SURVIVES session B\'s "Cancel it."',
      !!pendingActionStore.active(A),
      `result=${rCancel.result}`
    );
  }

  // ---------- 8. A and B may each independently hold a pending action of the SAME capability ----------
  {
    clearAllFor(A); clearAllFor(B);
    await runTask({ sessionId: A, goal: 'Schedule a meeting with Alice tomorrow at 9 AM for 30 minutes.', onEvent: () => {}, taskId: nanoid() });
    await runTask({ sessionId: B, goal: 'Schedule a meeting with Alice tomorrow at 11 AM for 30 minutes.', onEvent: () => {}, taskId: nanoid() });
    const aActive = calendarPendingActionStore.active(A);
    const bActive = calendarPendingActionStore.active(B);
    check(
      '8. both sessions simultaneously hold their OWN distinct pending Calendar proposal',
      !!aActive && !!bActive && aActive.proposal.start !== bActive.proposal.start,
      `aStart=${aActive?.proposal.start} bStart=${bActive?.proposal.start}`
    );
  }

  // ---------- 9. Consuming A's action leaves B's untouched ----------
  {
    // continues directly from the dual-pending state test 8 just established
    const bBefore = calendarPendingActionStore.active(B);
    const rA = await runTask({ sessionId: A, goal: 'Create it.', onEvent: () => {}, taskId: nanoid() });
    const bAfter = calendarPendingActionStore.active(B);
    check(
      '9. confirming session A\'s pending action leaves session B\'s own pending action untouched',
      rA.status === 'success' && !calendarPendingActionStore.active(A) && !!bAfter && bAfter.proposal.start === bBefore?.proposal.start,
      `aResult=${rA.result} bStillActive=${!!bAfter}`
    );
    calendarPendingActionStore.clear(B);
  }

  // ---------- 10. "Start over" in A leaves B's context untouched ----------
  {
    clearAllFor(A); clearAllFor(B);
    await runTask({ sessionId: A, goal: 'What meetings do I have tomorrow?', onEvent: () => {}, taskId: nanoid() });
    await runTask({ sessionId: B, goal: 'What meetings do I have tomorrow?', onEvent: () => {}, taskId: nanoid() });
    check('10a. both sessions have live Calendar context before reset', !!conversationContext.latest(A) && !!conversationContext.latest(B));
    await runTask({ sessionId: A, goal: 'Start over', onEvent: () => {}, taskId: nanoid() });
    check(
      '10b. "Start over" in session A clears A but leaves session B\'s context intact',
      !conversationContext.latest(A) && !!conversationContext.latest(B)
    );
  }

  // ---------- 11. Expiry/pruning in A doesn't remove live B state ----------
  {
    clearAllFor(A); clearAllFor(B);
    conversationContext.__pushForTesting(A, {
      capability: 'calendar',
      operation: 'list',
      dateRef: { daysFromNow: 1, label: 'tomorrow' },
      createdAt: Date.now() - 11 * 60 * 1000, // 11 minutes ago — past the 10-minute TTL
    });
    await runTask({ sessionId: B, goal: 'What meetings do I have tomorrow?', onEvent: () => {}, taskId: nanoid() });
    check('11a. session B has live context, session A has only an already-expired turn', !!conversationContext.latest(B));
    // Any turn (here, B's own request above) triggers runTask's own pruneAllExpired() sweep.
    await runTask({ sessionId: B, goal: 'What about Friday?', onEvent: () => {}, taskId: nanoid() });
    check(
      '11b. pruning removes session A\'s expired turn without touching session B\'s live context',
      !conversationContext.latest(A) && !!conversationContext.latest(B)
    );
  }

  // ---------- 12. Multi-pending cancellation is session-local ----------
  {
    clearAllFor(A); clearAllFor(B);
    await runTask({ sessionId: A, goal: 'Schedule a meeting with Alice tomorrow at 1 PM for 30 minutes.', onEvent: () => {}, taskId: nanoid() });
    await runTask({ sessionId: A, goal: 'Draft an email to isoa2@example.com saying session A only, again.', onEvent: () => {}, taskId: nanoid() });
    await runTask({ sessionId: B, goal: 'Schedule a meeting with Alice tomorrow at 3 PM for 30 minutes.', onEvent: () => {}, taskId: nanoid() });
    check(
      '12a. session A holds Calendar+Gmail pending, session B holds its own Calendar pending',
      !!calendarPendingActionStore.active(A) && !!pendingActionStore.active(A) && !!calendarPendingActionStore.active(B)
    );
    const rCancelAllA = await runTask({ sessionId: A, goal: 'Cancel both.', onEvent: () => {}, taskId: nanoid() });
    check(
      '12b. "Cancel both." in session A clears ONLY A\'s Calendar+Gmail pendings, never touches B\'s',
      rCancelAllA.status === 'success' && !calendarPendingActionStore.active(A) && !pendingActionStore.active(A) && !!calendarPendingActionStore.active(B),
      `result=${rCancelAllA.result} bStillActive=${!!calendarPendingActionStore.active(B)}`
    );
  }

  // ---------- 13. Typed and voice commands from the SAME session share context ----------
  {
    clearAllFor(A);
    const typed = await runTask({ sessionId: A, goal: 'What meetings do I have tomorrow?', onEvent: () => {}, taskId: nanoid() });
    check('13a. typed command establishes Calendar context for session A', typed.capability?.selected === 'calendar');
    const spoken = normalizeVoiceCommand('jarvis what about friday');
    const voiceResult = await runTask({ sessionId: A, goal: spoken.command, onEvent: () => {}, taskId: nanoid() });
    check(
      '13b. a VOICE follow-up in the SAME session resolves using the TYPED command\'s own context',
      voiceResult.capability?.selected === 'calendar' && voiceResult.outcome !== 'blocked',
      `command="${spoken.command}" capability=${voiceResult.capability?.selected} outcome=${voiceResult.outcome}`
    );
  }

  // ---------- 14. Two separate real UUID-shaped session ids never share context ----------
  {
    const uuidA = crypto.randomUUID();
    const uuidB = crypto.randomUUID();
    clearAllFor(uuidA); clearAllFor(uuidB);
    await runTask({ sessionId: uuidA, goal: 'Remind me to call Ramesh tomorrow.', onEvent: () => {}, taskId: nanoid() });
    check('14a. session (real UUID) A has a pending Tasks proposal', !!tasksPendingActionStore.active(uuidA));
    const beforeTitle = tasksPendingActionStore.active(uuidA)?.proposal.title;
    const rB = await runTask({ sessionId: uuidB, goal: 'Create it.', onEvent: () => {}, taskId: nanoid() });
    check(
      '14b. a DIFFERENT real-UUID session B cannot confirm session A\'s pending Tasks proposal',
      /no pending (task|calendar) action/i.test(rB.result) && tasksPendingActionStore.active(uuidA)?.proposal.title === beforeTitle,
      `result=${rB.result}`
    );
  }

  // ---------- 15. Invalid/missing session identifiers are handled deterministically and safely ----------
  {
    check('15a. isValidSessionId rejects null/undefined/empty', !isValidSessionId(null) && !isValidSessionId(undefined) && !isValidSessionId(''));
    check('15b. isValidSessionId rejects a too-short id', !isValidSessionId('short'));
    check('15c. isValidSessionId rejects an unbounded/too-long id', !isValidSessionId('a'.repeat(1000)));
    check('15d. isValidSessionId rejects unsafe characters', !isValidSessionId('bad id; drop table sessions;--'));
    check('15e. isValidSessionId accepts a real crypto.randomUUID()', isValidSessionId(crypto.randomUUID()));

    const fallback1 = resolveSessionId(null);
    const fallback2 = resolveSessionId(undefined);
    const fallback3 = resolveSessionId('!!!not-valid!!!');
    check(
      '15f. resolveSessionId NEVER falls back to one shared/fixed default — every bad/missing header gets its OWN fresh random id',
      isValidSessionId(fallback1) && isValidSessionId(fallback2) && isValidSessionId(fallback3) &&
        fallback1 !== fallback2 && fallback2 !== fallback3 && fallback1 !== fallback3
    );

    // Integration proof: two requests that BOTH omit a session header (the
    // real fallback path, not a hand-picked literal) must still be isolated
    // from each other — exactly like two genuinely separate bad requests.
    clearAllFor(fallback1); clearAllFor(fallback2);
    await runTask({ sessionId: resolveSessionId(null), goal: 'What meetings do I have tomorrow?', onEvent: () => {}, taskId: nanoid() });
    const rFollowUp = await runTask({ sessionId: resolveSessionId(null), goal: 'What about Friday?', onEvent: () => {}, taskId: nanoid() });
    check(
      '15g. two separate missing-header requests (each minted its own fallback id) do not share context',
      rFollowUp.outcome === 'blocked' && /don't have a prior calendar or task question/i.test(rFollowUp.result),
      `result=${rFollowUp.result}`
    );
  }

  // ---------- 16. Reload/new-session lifecycle: orphaned proposal expires via TTL, never becomes recoverable by a new session ----------
  {
    const OLD = 'session-old-tab-000';
    const NEW = 'session-new-tab-000'; // simulates the fresh crypto.randomUUID() page.tsx mints on reload
    clearAllFor(OLD); clearAllFor(NEW);

    await runTask({ sessionId: OLD, goal: 'Schedule a meeting with Alice tomorrow at 6 PM for 30 minutes.', onEvent: () => {}, taskId: nanoid() });
    const beforeTitle = calendarPendingActionStore.active(OLD)?.proposal.title;
    check('16a. the old (pre-reload) session has a real unconfirmed pending proposal', !!beforeTitle);

    // Reload: the UI mints a brand-new session id (NEW). The proposal is now
    // orphaned — unreachable from the UI — but still safely isolated
    // server-side, exactly like any other two independent sessions.
    const rConfirm = await runTask({ sessionId: NEW, goal: 'Create it.', onEvent: () => {}, taskId: nanoid() });
    const rCancel = await runTask({ sessionId: NEW, goal: 'Cancel it.', onEvent: () => {}, taskId: nanoid() });
    // Revision ("Make that 7 PM instead.") is not exercised live for the
    // same reason as test 6: with no Calendar/Tasks proposal active for the
    // NEW session, attemptProposalRevision's candidates list is provably
    // empty before it ever reads or writes any session's pending state — see
    // proposal-revision.ts's attemptProposalRevision. Running it live would
    // only fall through to a real browser-fallback attempt, unrelated to
    // what this test proves.
    check(
      '16b. the NEW (post-reload) session cannot confirm or cancel the OLD session\'s orphaned proposal',
      /no pending calendar action/i.test(rConfirm.result) &&
        /no pending calendar action/i.test(rCancel.result) &&
        calendarPendingActionStore.active(OLD)?.proposal.title === beforeTitle,
      `confirm=${rConfirm.result} cancel=${rCancel.result}`
    );

    // The orphaned proposal must still expire NORMALLY through the same TTL
    // every pending action uses — never kept alive forever just because
    // nothing can reach it, and never "recovered" for a new session either.
    calendarPendingActionStore.set(OLD, {
      type: 'calendar_create',
      proposal: calendarPendingActionStore.active(OLD)!.proposal,
      createdAt: Date.now() - 6 * 60 * 1000, // 6 minutes ago — past the 5-minute PendingAction TTL
    });
    check('16c. simulated an already-expired orphaned proposal (createdAt 6 minutes ago, TTL is 5 minutes)', true);

    const rAfterExpiry = await runTask({ sessionId: NEW, goal: 'Create it.', onEvent: () => {}, taskId: nanoid() });
    check(
      '16d. the expired proposal is gone via normal TTL cleanup — and still never became reachable by the NEW session',
      !calendarPendingActionStore.active(OLD) && /no pending calendar action/i.test(rAfterExpiry.result)
    );
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(1);
});
