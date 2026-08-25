/**
 * Checkpoint 17 §14 — Gmail draft tests A-E, against the deterministic mock
 * mailbox. Every case here must NEVER actually send anything — only
 * createDraft() should ever be reachable from these flows.
 */
process.env.USE_MOCK_GMAIL = 'true';

import { runTask } from '@/core/agent/task-manager';
import { pendingActionStore } from '@/core/capabilities/gmail/pending-action';
import { nanoid } from 'nanoid';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

async function main() {
  pendingActionStore.clear();

  // ---------- A: draft simple email ----------
  {
    const r = await runTask({ goal: 'Jarvis, draft an email to test@example.com saying I will join at three.', onEvent: () => {}, taskId: nanoid() });
    check(
      'A. simple draft — DRAFT CREATED, correct recipient/body, pending action set, nothing sent',
      r.status === 'success' &&
        r.gmail?.operation === 'draft' &&
        /DRAFT CREATED/.test(r.result) &&
        /test@example\.com/.test(r.result) &&
        !!r.gmail?.pendingAction &&
        r.gmail.pendingAction.confirmationRequired === true,
      `status=${r.status} result=${r.result.slice(0, 200)}`
    );
    pendingActionStore.clear();
  }

  // ---------- B: draft with explicit subject + body ----------
  {
    const r = await runTask({
      goal: 'Write an email to user@example.com with subject "Lunch plans" saying let us grab lunch tomorrow.',
      onEvent: () => {},
      taskId: nanoid(),
    });
    check(
      'B. draft with explicit subject — subject captured correctly, not defaulted',
      r.status === 'success' && /Lunch plans/.test(r.result),
      `status=${r.status} result=${r.result.slice(0, 200)}`
    );
    pendingActionStore.clear();
  }

  // ---------- C: draft with CC ----------
  {
    const r = await runTask({
      goal: 'Draft an email to user@example.com cc manager@example.com saying the report is attached.',
      onEvent: () => {},
      taskId: nanoid(),
    });
    check(
      'C. draft with CC — CC address captured',
      r.status === 'success' && /manager@example\.com/.test(r.result),
      `status=${r.status} result=${r.result.slice(0, 200)}`
    );
    pendingActionStore.clear();
  }

  // ---------- D: invalid recipient -> fail safely ----------
  {
    const r = await runTask({ goal: 'Draft an email to notanemail saying hello.', onEvent: () => {}, taskId: nanoid() });
    check(
      'D. invalid recipient — fails/blocks safely, no draft created, no pending action, no crash',
      r.status !== 'success' || r.outcome === 'blocked',
      `status=${r.status} outcome=${r.outcome} pending=${!!r.gmail?.pendingAction} result=${r.result.slice(0, 150)}`
    );
    check('D. invalid recipient — no pending send action was created', !pendingActionStore.active());
  }

  // ---------- E: missing recipient -> clarification, not a guess ----------
  {
    const r = await runTask({ goal: 'Draft an email to Alex saying I will join at three.', onEvent: () => {}, taskId: nanoid() });
    check(
      'E. missing recipient (name, not an address) — asks for clarification, never fabricates an address for "Alex"',
      r.outcome === 'blocked' && /recipient/i.test(r.result) && !/alex@/i.test(r.result),
      `status=${r.status} outcome=${r.outcome} result=${r.result.slice(0, 200)}`
    );
    check('E. missing recipient — no draft/pending action created', !pendingActionStore.active());
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
