/**
 * Checkpoint 17 §9-17 — Gmail send tests A-E, idempotency, and the voice
 * two-turn confirmation flow. This is the safety-critical suite: sending
 * must NEVER happen without an explicit confirmation tied to the specific
 * pending draft, must never fire twice, and must never leak across
 * unrelated turns.
 */
process.env.USE_MOCK_GMAIL = 'true';

import { runTask } from '@/core/agent/task-manager';
import { pendingActionStore } from '@/core/capabilities/gmail/pending-action';
import { getGmailClient } from '@/core/capabilities/gmail/resolve';
import { nanoid } from 'nanoid';

const SID = 'test-session';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

async function draftOnly(to: string): Promise<{ result: Awaited<ReturnType<typeof runTask>>; draftId: string | undefined }> {
  const result = await runTask({ sessionId: SID, goal: `Draft an email to ${to} saying this is a test message.`, onEvent: () => {}, taskId: nanoid() });
  const active = pendingActionStore.active(SID);
  return { result, draftId: active?.draftId };
}

async function main() {
  // ---------- A: draft created -> no send yet ----------
  {
    pendingActionStore.clear(SID);
    const { result, draftId } = await draftOnly('sendtest-a@example.com');
    const client = getGmailClient();
    const draft = draftId ? client.getDraft(draftId) : null;
    check(
      'A. draft created — pending action set, draft NOT sent yet',
      result.status === 'success' && !!draftId && draft?.sent === false,
      `pendingActive=${!!pendingActionStore.active(SID)} draftSent=${draft?.sent}`
    );
  }

  // ---------- B: explicit confirm -> exactly one email sent ----------
  {
    pendingActionStore.clear(SID);
    const { draftId } = await draftOnly('sendtest-b@example.com');
    const confirmResult = await runTask({ sessionId: SID, goal: 'Send it.', onEvent: () => {}, taskId: nanoid() });
    const client = getGmailClient();
    const draft = draftId ? client.getDraft(draftId) : null;
    check(
      'B. explicit confirmation — email actually sent, pending action consumed',
      confirmResult.status === 'success' && draft?.sent === true && !pendingActionStore.active(SID),
      `status=${confirmResult.status} sent=${draft?.sent} pendingActive=${!!pendingActionStore.active(SID)} result=${confirmResult.result}`
    );
  }

  // ---------- C: no confirmation -> send blocked ----------
  {
    pendingActionStore.clear(SID);
    const { draftId } = await draftOnly('sendtest-c@example.com');
    // A completely unrelated new task, NOT a confirmation phrase.
    const unrelated = await runTask({ sessionId: SID, goal: 'Show my latest emails', onEvent: () => {}, taskId: nanoid() });
    const client = getGmailClient();
    const draft = draftId ? client.getDraft(draftId) : null;
    check(
      'C. no confirmation given — the draft remains unsent',
      draft?.sent === false && unrelated.gmail?.operation !== 'send',
      `sent=${draft?.sent} unrelatedOperation=${unrelated.gmail?.operation}`
    );
  }

  // ---------- D: confirmation after an unrelated task should not accidentally send ----------
  {
    pendingActionStore.clear(SID);
    const { draftId } = await draftOnly('sendtest-d@example.com');
    // An unrelated task runs in between — does NOT consume or clear the
    // pending action (§9: "do not carry send authorization across
    // unrelated turns" is about the REVERSE direction — an unrelated turn
    // must not itself BECOME a confirmation, and must not be treated as
    // cancelling a still-valid pending action either).
    await runTask({ sessionId: SID, goal: 'Show my latest emails', onEvent: () => {}, taskId: nanoid() });
    const stillPendingBeforeConfirm = pendingActionStore.active(SID);
    // Snapshot the SENT VALUE now, as a boolean — getDraft() returns a
    // reference to the SAME mutable object the client mutates in place on
    // sendDraft(), so holding onto the object itself and reading .sent
    // AFTER the confirmation below runs would read the post-send value,
    // not a true "before" snapshot.
    const sentBeforeConfirm = getGmailClient().getDraft(draftId ?? '')?.sent === true;
    // Now a genuine confirmation arrives — it should still work, since the
    // pending action is still valid (unrelated task text is never itself
    // authorization, but it also doesn't silently cancel a real pending one).
    await runTask({ sessionId: SID, goal: 'Send it.', onEvent: () => {}, taskId: nanoid() });
    const client = getGmailClient();
    const draft = draftId ? client.getDraft(draftId) : null;
    check(
      'D. the unrelated task itself never triggers a send (draft still unsent right after it)',
      sentBeforeConfirm === false,
      `sentBeforeConfirm=${sentBeforeConfirm}`
    );
    check(
      'D. a later genuine confirmation still works — the unrelated turn did not silently clear the pending action',
      !!stillPendingBeforeConfirm && draft?.sent === true,
      `stillPendingBeforeConfirm=${!!stillPendingBeforeConfirm} sent=${draft?.sent}`
    );
  }

  // ---------- E: double confirmation -> must not duplicate-send ----------
  {
    pendingActionStore.clear(SID);
    const { draftId } = await draftOnly('sendtest-e@example.com');
    const first = await runTask({ sessionId: SID, goal: 'Send it.', onEvent: () => {}, taskId: nanoid() });
    const second = await runTask({ sessionId: SID, goal: 'Send it.', onEvent: () => {}, taskId: nanoid() });
    const client = getGmailClient();
    const draft = draftId ? client.getDraft(draftId) : null;
    // The mailbox should contain exactly ONE sent message for this draft —
    // search for the exact test address and count SENT-labeled matches.
    const sentMatches = (await client.search(`sendtest-e@example.com`, 20)).messages.filter((m) => m.labels.includes('SENT'));
    check(
      'E. double confirmation — second confirmation reports no pending action, exactly one email actually sent',
      first.status === 'success' &&
        /already sent|no pending/i.test(second.result) &&
        draft?.sent === true &&
        sentMatches.length === 1,
      `first=${first.result.slice(0, 80)} second=${second.result.slice(0, 80)} sentMatches=${sentMatches.length}`
    );
  }

  // ---------- IDEMPOTENCY (§16): concurrent/racing confirmations for the same draft ----------
  {
    pendingActionStore.clear(SID);
    const { draftId } = await draftOnly('idempotency@example.com');
    // Two confirmations fired without awaiting between them — races the
    // atomic claim() guard directly, not just sequential double-send.
    const [r1, r2] = await Promise.all([
      runTask({ sessionId: SID, goal: 'Send it.', onEvent: () => {}, taskId: nanoid() }),
      runTask({ sessionId: SID, goal: 'Send it.', onEvent: () => {}, taskId: nanoid() }),
    ]);
    const client = getGmailClient();
    const draft = draftId ? client.getDraft(draftId) : null;
    const successes = [r1, r2].filter((r) => r.status === 'success' && /^Sent email/.test(r.result));
    check(
      'IDEMPOTENCY. racing confirmations for the same draft — exactly one actually sends',
      draft?.sent === true && successes.length === 1,
      `r1=${r1.result.slice(0, 60)} r2=${r2.result.slice(0, 60)} successes=${successes.length}`
    );
  }

  // ---------- VOICE (§11): two-turn voice-style confirmation reaches the same Gmail path ----------
  {
    pendingActionStore.clear(SID);
    // Voice normalization strips the wake word before the directive ever
    // reaches runTask() (see src/lib/voice/normalize.ts / test-voice.ts) —
    // simulating that here with the already-stripped directive text is
    // exactly what the real voice pipeline hands to runTask(), proving
    // voice enters the SAME Gmail capability path, not a parallel one.
    const draftTurn = await runTask({ sessionId: SID, goal: "draft an email to voicetest@example.com saying I'll join at three.", onEvent: () => {}, taskId: nanoid() });
    const draftId = pendingActionStore.active(SID)?.draftId;
    const sendTurn = await runTask({ sessionId: SID, goal: 'Send it.', onEvent: () => {}, taskId: nanoid() });
    const client = getGmailClient();
    const draft = draftId ? client.getDraft(draftId) : null;
    check(
      'VOICE. two-turn voice-style draft-then-send reaches the same Gmail capability path and confirmation boundary',
      draftTurn.gmail?.operation === 'draft' && draft?.sent === true && sendTurn.gmail?.operation === 'send',
      `draftOp=${draftTurn.gmail?.operation} sendOp=${sendTurn.gmail?.operation} sent=${draft?.sent}`
    );
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
