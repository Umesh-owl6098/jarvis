/**
 * Checkpoint 19 §11 D/H — the two Gmail+Contacts cases not already covered
 * by test-checkpoint19-gmail-contacts.ts: a contact with multiple
 * non-primary emails (must ask, never guess) and cancellation mid-lookup
 * (no draft, no pending action).
 */
process.env.USE_MOCK_GMAIL = 'true';
process.env.USE_MOCK_CONTACTS = 'true';

import { runTask } from '@/core/agent/task-manager';
import { pendingActionStore } from '@/core/capabilities/gmail/pending-action';
import { nanoid } from 'nanoid';

const SID = 'test-session';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

async function main() {
  // ---------- D: contact with two emails, neither marked primary -> clarification, zero drafts ----------
  {
    pendingActionStore.clear(SID);
    const r = await runTask({ sessionId: SID, goal: 'Draft an email to Sam saying are we still on for lunch', onEvent: () => {}, taskId: nanoid() });
    check(
      'D. multi-email contact with no primary -> clarification, no draft, no pending action',
      r.outcome === 'blocked' && /use .*sam\.work@example\.com.* or .*sam\.personal@example\.com/i.test(r.result) && !pendingActionStore.active(SID),
      `outcome=${r.outcome} result=${r.result.slice(0, 250)}`
    );
  }

  // ---------- H: cancellation mid-lookup -> stopped, no draft, no pending action ----------
  {
    pendingActionStore.clear(SID);
    const controller = new AbortController();
    controller.abort();
    const r = await runTask({ sessionId: SID, goal: 'Draft an email to Alice saying hello', onEvent: () => {}, signal: controller.signal, taskId: nanoid() });
    check(
      'H. cancelled before Contacts lookup resolves -> stopped, no draft, no pending action',
      r.status === 'stopped' && !pendingActionStore.active(SID),
      `status=${r.status} result=${r.result.slice(0, 200)} pendingActive=${!!pendingActionStore.active(SID)}`
    );
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
