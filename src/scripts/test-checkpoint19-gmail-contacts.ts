/**
 * Checkpoint 19 §17 — Gmail + Contacts integration tests A-E.
 */
process.env.USE_MOCK_GMAIL = 'true';
process.env.USE_MOCK_CONTACTS = 'true';

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

async function main() {
  // ---------- A: "Draft an email to Alice saying hello" -> resolves, drafts, does NOT send ----------
  {
    pendingActionStore.clear(SID);
    const r = await runTask({ sessionId: SID, goal: 'Draft an email to Alice saying hello', onEvent: () => {}, taskId: nanoid() });
    check(
      'A. name resolves via Contacts, draft created with the resolved email, not sent',
      r.status === 'success' && /DRAFT CREATED/.test(r.result) && /alice@example\.com/.test(r.result) && r.resolution?.status === 'resolved',
      `result=${r.result.slice(0, 200)} resolution=${JSON.stringify(r.resolution)}`
    );
    const client = getGmailClient();
    const sent = (await client.search('hello', 10)).messages.filter((m) => m.labels.includes('SENT'));
    check('A2. nothing was actually sent', sent.length === 0, `sentCount=${sent.length}`);
  }

  // ---------- B: ambiguous "John Smith" -> clarification, no draft ----------
  {
    pendingActionStore.clear(SID);
    const r = await runTask({ sessionId: SID, goal: 'Draft an email to John Smith saying are you free today', onEvent: () => {}, taskId: nanoid() });
    check(
      'B. ambiguous contact -> clarification shown, no draft created, no pending action',
      r.outcome === 'blocked' && /Which one/i.test(r.result) && !pendingActionStore.active(SID),
      `outcome=${r.outcome} result=${r.result.slice(0, 200)} pending=${!!pendingActionStore.active(SID)}`
    );
  }

  // ---------- C: no such contact -> clarification, no draft ----------
  {
    pendingActionStore.clear(SID);
    const r = await runTask({ sessionId: SID, goal: 'Draft an email to Zorblax saying hello', onEvent: () => {}, taskId: nanoid() });
    check(
      'C. unknown name -> clarification asking for explicit email, no draft, no pending action',
      r.outcome === 'blocked' && /couldn't find/i.test(r.result) && !pendingActionStore.active(SID),
      `outcome=${r.outcome} result=${r.result.slice(0, 200)}`
    );
  }

  // ---------- D: explicit email still works exactly as before (no Contacts involvement) ----------
  {
    pendingActionStore.clear(SID);
    const r = await runTask({ sessionId: SID, goal: 'Draft an email to explicit@example.com saying hello', onEvent: () => {}, taskId: nanoid() });
    check(
      'D. explicit email address bypasses Contacts entirely, works exactly as Checkpoint 17',
      r.status === 'success' && /DRAFT CREATED/.test(r.result) && /explicit@example\.com/.test(r.result) && r.resolution === undefined,
      `result=${r.result.slice(0, 200)} resolution=${JSON.stringify(r.resolution)}`
    );
  }

  // ---------- E: duplicate send protection remains unchanged after a Contacts-resolved draft ----------
  {
    pendingActionStore.clear(SID);
    await runTask({ sessionId: SID, goal: 'Draft an email to Alice saying duplicate protection check', onEvent: () => {}, taskId: nanoid() });
    const first = await runTask({ sessionId: SID, goal: 'Send it.', onEvent: () => {}, taskId: nanoid() });
    const second = await runTask({ sessionId: SID, goal: 'Send it.', onEvent: () => {}, taskId: nanoid() });
    check(
      'E. send-confirmation/idempotency behavior is unchanged for a Contacts-resolved draft',
      first.status === 'success' && /^Sent email/.test(first.result) && /no pending/i.test(second.result),
      `first=${first.result} second=${second.result}`
    );
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
