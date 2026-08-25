/**
 * Checkpoint 17 §17 — cancellation while searching/reading/drafting stops
 * cleanly; a send that has already been accepted by the (mock) Gmail
 * backend is never retroactively reported as cancelled.
 */
process.env.USE_MOCK_GMAIL = 'true';

import { runTask } from '@/core/agent/task-manager';
import { pendingActionStore } from '@/core/capabilities/gmail/pending-action';
import { getGmailClient } from '@/core/capabilities/gmail/resolve';
import { nanoid } from 'nanoid';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

async function main() {
  pendingActionStore.clear();

  // ---------- A: cancelled before a search even starts ----------
  {
    const controller = new AbortController();
    controller.abort();
    const r = await runTask({ goal: 'Find the email from John', onEvent: () => {}, signal: controller.signal, taskId: nanoid() });
    check(
      'A. search cancelled before it starts — reports stopped, not a false completion',
      r.status === 'stopped',
      `status=${r.status} result=${r.result}`
    );
  }

  // ---------- B: cancelled before a read starts ----------
  {
    const controller = new AbortController();
    controller.abort();
    const r = await runTask({ goal: 'Read my latest thread', onEvent: () => {}, signal: controller.signal, taskId: nanoid() });
    check('B. read cancelled before it starts — reports stopped', r.status === 'stopped', `status=${r.status}`);
  }

  // ---------- C: cancelled before a draft is created — no draft, no pending action ----------
  {
    pendingActionStore.clear();
    const controller = new AbortController();
    controller.abort();
    const r = await runTask({ goal: 'Draft an email to canceltest@example.com saying hello.', onEvent: () => {}, signal: controller.signal, taskId: nanoid() });
    check(
      'C. draft cancelled before creation — stopped, no draft created, no pending action',
      r.status === 'stopped' && !pendingActionStore.active(),
      `status=${r.status} pendingActive=${!!pendingActionStore.active()}`
    );
  }

  // ---------- D: a send already accepted by Gmail must NEVER be reported as cancelled afterward ----------
  {
    pendingActionStore.clear();
    await runTask({ goal: 'Draft an email to cancelsend@example.com saying this should still send.', onEvent: () => {}, taskId: nanoid() });
    const draftId = pendingActionStore.active()?.draftId;
    // Abort ONLY after the send has already been accepted — simulated here
    // by sending first (mock resolves synchronously) and THEN checking
    // with an already-aborted signal on the confirmation call itself would
    // incorrectly test "cancel before" rather than "cancel after accepted."
    // The real guarantee under test is structural: sendDraft()'s own
    // idempotency check runs BEFORE its abort check (see mock-client.ts),
    // so a second call against an already-sent draft, even with an aborted
    // signal, must report the real prior success — never "stopped."
    const first = await runTask({ goal: 'Send it.', onEvent: () => {}, taskId: nanoid() });
    const controller = new AbortController();
    controller.abort();
    pendingActionStore.set({ type: 'gmail_send', draftId: draftId!, recipient: ['cancelsend@example.com'], subject: '(no subject)', createdAt: Date.now() });
    const second = await runTask({ goal: 'Send it.', onEvent: () => {}, signal: controller.signal, taskId: nanoid() });
    const client = getGmailClient();
    const draft = draftId ? client.getDraft(draftId) : null;
    check(
      'D. a send already accepted is never retroactively reported as cancelled, even if a later call carries an aborted signal',
      first.status === 'success' && draft?.sent === true && second.status === 'success',
      `first=${first.result} second=${second.result} secondStatus=${second.status} sent=${draft?.sent}`
    );
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
