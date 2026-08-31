/**
 * Checkpoint 17 §13 — Gmail read tests A-E, against the deterministic mock
 * mailbox (no real credentials/network needed — same philosophy as
 * USE_MOCK_ROUTER). Run through the ACTUAL production entrypoint
 * (task-manager.runTask), proving Gmail intent is intercepted before
 * decomposeTask/CapabilityRouter and that no browser is ever launched.
 */
process.env.USE_MOCK_GMAIL = 'true';

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
  pendingActionStore.clear(SID);

  // ---------- A: list latest 5 emails ----------
  {
    const r = await runTask({ sessionId: SID, goal: 'Show my latest emails', onEvent: () => {}, taskId: nanoid() });
    check(
      'A. list latest emails — completes via Gmail capability, no browser',
      r.status === 'success' && r.capability?.selected === 'gmail' && r.gmail?.operation === 'list' && r.result.length > 0,
      `status=${r.status} capability=${r.capability?.selected} operation=${r.gmail?.operation}`
    );
  }

  // ---------- B: search by sender ----------
  {
    const r = await runTask({ sessionId: SID, goal: 'Find the email from John', onEvent: () => {}, taskId: nanoid() });
    check(
      'B. search by sender — finds the John Invoice email',
      r.status === 'success' && r.gmail?.operation === 'search' && /invoice/i.test(r.result),
      `status=${r.status} result=${r.result.slice(0, 150)}`
    );
  }

  // ---------- C: search by subject keyword ----------
  {
    const r = await runTask({ sessionId: SID, goal: 'Search my email for the invoice', onEvent: () => {}, taskId: nanoid() });
    check(
      'C. search by subject keyword — finds the Invoice email',
      r.status === 'success' && r.gmail?.operation === 'search' && /invoice/i.test(r.result),
      `status=${r.status} result=${r.result.slice(0, 150)}`
    );
  }

  // ---------- D: read one thread ----------
  {
    const r = await runTask({ sessionId: SID, goal: 'Read my latest thread with Sarah', onEvent: () => {}, taskId: nanoid() });
    check(
      'D. read a specific thread — returns the real thread content, not a summary',
      r.status === 'success' && r.gmail?.operation === 'read' && /sarah/i.test(r.result) && /timeline/i.test(r.result),
      `status=${r.status} result=${r.result.slice(0, 150)}`
    );
  }

  // ---------- E: summarize one thread ----------
  {
    const r = await runTask({ sessionId: SID, goal: 'Summarize my latest thread with Sarah', onEvent: () => {}, taskId: nanoid() });
    check(
      'E. summarize a thread — completes, uses a real LLM call (tokens > 0), no browser',
      r.status === 'success' && r.gmail?.operation === 'summarize' && r.tokensUsed > 0,
      `status=${r.status} tokens=${r.tokensUsed} result=${r.result.slice(0, 150)}`
    );
  }

  // ---------- routing sanity: "Open gmail.com" must NOT be intercepted as Gmail capability ----------
  {
    const r = await runTask({ sessionId: SID, goal: 'Open gmail.com', onEvent: () => {}, taskId: nanoid() });
    check(
      'ROUTING. "Open gmail.com" is browser navigation, not the Gmail capability',
      r.capability?.selected !== 'gmail',
      `capability=${r.capability?.selected}`
    );
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
