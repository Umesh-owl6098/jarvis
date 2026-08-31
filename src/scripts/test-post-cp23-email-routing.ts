/**
 * Post-CP23 fix — bare "email <person>" routing gap, discovered during the
 * "call GV" phone-call fix's own verification: "email GV" matched no
 * capability detector at all (Gmail's own trigger list requires an
 * explicit draft/write/compose/send/reply/forward verb — bare "email"
 * isn't among them) and fell through to the same generic browser/OmniRoute
 * path "call GV" did before its own fix.
 *
 * Fix: a new bare-imperative shape in gmail/intent.ts (BARE_EMAIL_RE,
 * anchored to the START of the command so it can never match a generic
 * question/statement that merely mentions "email"), producing a 'draft'
 * intent with `needsBodyClarification: true`. gmail/runner.ts's draft case
 * checks that flag BEFORE ever calling createDraft() — recipient
 * resolution (including Contacts, reusing the existing CP19 mechanism)
 * still happens normally, but the response is always "What would you like
 * the email to say?", never a real empty-body draft.
 */
const TEST_PREFS_PATH = require('os').tmpdir() + '/jarvis-post-cp23-email-routing-' + Date.now() + '.json';
process.env.JARVIS_PREFERENCES_PATH = TEST_PREFS_PATH;

process.env.USE_MOCK_GMAIL = 'true';
process.env.USE_MOCK_CALENDAR = 'true';
process.env.USE_MOCK_TASKS = 'true';
process.env.USE_MOCK_CONTACTS = 'true';

import { runTask } from '@/core/agent/task-manager';
import { detectGmailIntent } from '@/core/capabilities/gmail/intent';
import { calendarPendingActionStore } from '@/core/capabilities/calendar/pending-action';
import { pendingActionStore } from '@/core/capabilities/gmail/pending-action';
import { tasksPendingActionStore } from '@/core/capabilities/tasks/pending-action';
import type { ExecutionResult } from '@/core/agent/executor';
import { nanoid } from 'nanoid';

const SID = 'test-session';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

function browserWasInvoked(r: ExecutionResult): boolean {
  return r.events.some((e) => e.type === 'browser.initialized');
}

function clearAllPending() {
  pendingActionStore.clear(SID);
  calendarPendingActionStore.clear(SID);
  tasksPendingActionStore.clear(SID);
}

async function main() {
  // ---------- Positive: bare "email <person>" reaches Gmail and asks for the body ----------
  for (const goal of ['email GV', 'Email John', 'email Sarah']) {
    clearAllPending();
    const r = await runTask({ sessionId: SID, goal, onEvent: () => {}, taskId: nanoid() });
    check(
      `"${goal}" -> Gmail, clarification (never invents a body, never fabricates content)`,
      // Any of the three honest clarification outcomes is acceptable here —
      // which one fires depends on the mock contact fixture (not found /
      // ambiguous / resolved-then-asked-for-a-body) — the shared invariant
      // under test is: Gmail capability, blocked outcome, no browser, and
      // never a real draft.
      r.capability?.selected === 'gmail' &&
        r.outcome === 'blocked' &&
        !browserWasInvoked(r) &&
        (/what would you like the email to say/i.test(r.result) || /couldn't find a contact/i.test(r.result) || /which one/i.test(r.result)),
      `capability=${r.capability?.selected} outcome=${r.outcome} result=${r.result}`
    );
    check(`"${goal}" -> zero pending Gmail send, zero pending anywhere`, !pendingActionStore.active(SID) && !calendarPendingActionStore.active(SID) && !tasksPendingActionStore.active(SID));
  }

  // ---------- Positive, with a resolvable mock contact: confirms the clarification path specifically (not just the recipient-not-found path) ----------
  {
    clearAllPending();
    const r = await runTask({ sessionId: SID, goal: 'email Alice', onEvent: () => {}, taskId: nanoid() });
    check(
      '"email Alice" (resolvable contact) -> exact clarification message, recipient resolved, no draft created',
      r.capability?.selected === 'gmail' &&
        r.result === 'What would you like the email to say?' &&
        r.resolution?.status === 'resolved' &&
        !browserWasInvoked(r) &&
        !pendingActionStore.active(SID),
      `result=${r.result} resolution=${JSON.stringify(r.resolution)}`
    );
    clearAllPending();
  }

  // ---------- Negative classification: generic questions/statements about email must never be caught ----------
  const negatives = [
    'What is email marketing?',
    'How does email work?',
    'Explain email authentication',
    'Search for email security best practices',
    'Open my email provider website',
  ];
  for (const goal of negatives) {
    const intent = detectGmailIntent(goal);
    check(`"${goal}" is NOT classified as a bare-email draft request`, intent === null || intent.needsBodyClarification !== true, JSON.stringify(intent));
  }

  // ---------- Existing Gmail behavior preserved ----------
  {
    clearAllPending();
    const r = await runTask({ sessionId: SID, goal: 'draft an email to GV saying hello', onEvent: () => {}, taskId: nanoid() });
    check('"draft an email to GV saying hello" still reaches Gmail with the body intact (unaffected by this fix)', r.capability?.selected === 'gmail', `result=${r.result}`);
    clearAllPending();
  }
  {
    const r = await runTask({ sessionId: SID, goal: 'Send it.', onEvent: () => {}, taskId: nanoid() });
    check('"Send it." with nothing pending still gets the honest "nothing pending" answer (unaffected)', /no pending email/i.test(r.result), `result=${r.result}`);
  }
  {
    const r = await runTask({ sessionId: SID, goal: 'find my latest email', onEvent: () => {}, taskId: nanoid() });
    check('"find my latest email" still reaches Gmail (unaffected)', r.capability?.selected === 'gmail', `result=${r.result?.slice(0, 80)}`);
  }
  {
    const r = await runTask({ sessionId: SID, goal: 'what emails did I get today?', onEvent: () => {}, taskId: nanoid() });
    check('"what emails did I get today?" still reaches Gmail (unaffected)', r.capability?.selected === 'gmail', `result=${r.result?.slice(0, 80)}`);
  }

  // ---------- Critical cross-capability regressions ----------
  {
    clearAllPending();
    const r = await runTask({ sessionId: SID, goal: 'call GV', onEvent: () => {}, taskId: nanoid() });
    check('"call GV" -> still unsupported phone call (unaffected by the email fix)', r.capability?.selected === 'unsupported' && r.result === "I can't place phone calls yet.", `result=${r.result}`);
  }
  {
    clearAllPending();
    const r = await runTask({ sessionId: SID, goal: 'schedule a meeting with GV tomorrow at 2 PM', onEvent: () => {}, taskId: nanoid() });
    check('"schedule a meeting with GV tomorrow at 2 PM" -> still Calendar/Contacts (unaffected)', r.capability?.selected === 'calendar' && !!r.resolution, `capability=${r.capability?.selected}`);
    clearAllPending();
  }
  {
    clearAllPending();
    const r = await runTask({ sessionId: SID, goal: 'create a task to call GV tomorrow', onEvent: () => {}, taskId: nanoid() });
    const active = tasksPendingActionStore.active(SID);
    check('"create a task to call GV tomorrow" -> still Tasks (unaffected)', r.capability?.selected === 'tasks' && active?.proposal.title === 'Call GV', `capability=${r.capability?.selected} title=${active?.proposal.title}`);
    clearAllPending();
  }
  {
    clearAllPending();
    const r = await runTask({ sessionId: SID, goal: 'create a task to email GV tomorrow', onEvent: () => {}, taskId: nanoid() });
    const active = tasksPendingActionStore.active(SID);
    check(
      '"create a task to email GV tomorrow" -> Tasks, NOT Gmail — embedded "email GV" content is not stolen by the new bare-email guard',
      r.capability?.selected === 'tasks' && active?.proposal.title === 'Email GV',
      `capability=${r.capability?.selected} title=${active?.proposal.title} result=${r.result}`
    );
    clearAllPending();
  }
  {
    clearAllPending();
    const r = await runTask({ sessionId: SID, goal: 'create a task to email GV tomorrow saying hello', onEvent: () => {}, taskId: nanoid() });
    check(
      '"create a task to email GV tomorrow saying hello" -> Tasks',
      r.capability?.selected === 'tasks',
      `capability=${r.capability?.selected} result=${r.result}`
    );
    clearAllPending();
  }

  // ---------- Structural: the new bare-email regex never matches when Tasks' own create-verb prefix is present ----------
  {
    check(
      'detectGmailIntent("create a task to email GV tomorrow") returns null — Tasks claims it first in routing order, but even in isolation this never matches the bare-email shape',
      detectGmailIntent('create a task to email GV tomorrow') === null
    );
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
