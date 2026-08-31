/**
 * Post-CP23 production routing safety fix — Parts A/B/C deterministic
 * coverage.
 *
 * Part A root cause (see the delivered report for the full trace): "call
 * GV" matched NO deterministic layer — not the CP23 preference detector,
 * not CP22's context/revision layer, not CP21 orchestration, not Gmail's
 * verb list (draft/write/compose/send/reply/forward — "call" isn't among
 * them), not Calendar's (create/book/set up/schedule), not Tasks' (remind
 * me to / add a task/reminder) — so it fell all the way through
 * classifyGoal -> decomposeTask -> routeCapability -> the generic browser/
 * OmniRoute agent, which has no way to know a phone call isn't a web task.
 *
 * Part B fix: a new, narrow, concept-based guard
 * (shared/unsupported-intent.ts) checked after Gmail's own intent check
 * and before subgoal decomposition — an immediate, honest "I can't place
 * phone calls yet.", never touching Contacts, never initializing the
 * browser, never calling OmniRoute.
 *
 * Also covers the Tasks/Calendar routing collision found and fixed along
 * the way: "create a task to call GV tomorrow" was being wrongly claimed
 * by Calendar's overly-broad CREATE_VERB_RE (create + any following word)
 * before Tasks' own (narrower, "add a task to X"-only) detector ever got a
 * chance — fixed with a shared guard (mirroring gmail-guard.ts's existing
 * pattern) plus broadening Tasks' own trigger to also accept "create".
 */
const TEST_PREFS_PATH = require('os').tmpdir() + '/jarvis-post-cp23-call-routing-' + Date.now() + '.json';
process.env.JARVIS_PREFERENCES_PATH = TEST_PREFS_PATH;

process.env.USE_MOCK_GMAIL = 'true';
process.env.USE_MOCK_CALENDAR = 'true';
process.env.USE_MOCK_TASKS = 'true';
process.env.USE_MOCK_CONTACTS = 'true';

import { runTask } from '@/core/agent/task-manager';
import { isUnsupportedPhoneCallIntent } from '@/core/capabilities/shared/unsupported-intent';
import { detectGmailIntent } from '@/core/capabilities/gmail/intent';
import { detectCalendarIntent } from '@/core/capabilities/calendar/intent';
import { detectTasksIntent } from '@/core/capabilities/tasks/intent';
import { calendarPendingActionStore } from '@/core/capabilities/calendar/pending-action';
import { pendingActionStore } from '@/core/capabilities/gmail/pending-action';
import { tasksPendingActionStore } from '@/core/capabilities/tasks/pending-action';
import { preferencesStore } from '@/core/preferences/store';
import type { ExecutionResult } from '@/core/agent/executor';
import { nanoid } from 'nanoid';
import { readFileSync } from 'fs';

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
  // ---------- Positive: personal phone-call commands are unsupported, fast, and side-effect-free ----------
  for (const goal of ['call GV', 'Call John', 'phone Sarah', 'ring Alex']) {
    clearAllPending();
    preferencesStore.forgetAll();
    const before = { cal: !!calendarPendingActionStore.active(SID), gmail: !!pendingActionStore.active(SID), tasks: !!tasksPendingActionStore.active(SID) };
    const r = await runTask({ sessionId: SID, goal, onEvent: () => {}, taskId: nanoid() });
    check(
      `"${goal}" -> unsupported, exact honest message, no browser initialization`,
      r.capability?.selected === 'unsupported' &&
        r.result === "I can't place phone calls yet." &&
        !browserWasInvoked(r) &&
        r.status === 'success' &&
        r.outcome === 'blocked',
      `capability=${r.capability?.selected} result=${r.result}`
    );
    check(
      `"${goal}" -> zero remote mutations, zero pending actions, zero preference mutations`,
      !before.cal && !before.gmail && !before.tasks &&
        !calendarPendingActionStore.active(SID) && !pendingActionStore.active(SID) && !tasksPendingActionStore.active(SID) &&
        Object.keys(preferencesStore.getAll()).length === 0
    );
  }

  // ---------- Negative classification: unrelated uses of "call" must never be caught ----------
  const negatives = [
    'What is a function call?',
    'Explain a function call',
    'What is a call option?',
    'What does call mean in JavaScript?',
    'Open the Call of Duty website',
    'Search for Call of Duty',
  ];
  for (const goal of negatives) {
    check(`"${goal}" is NOT classified as an unsupported phone-call request`, !isUnsupportedPhoneCallIntent(goal));
  }

  // ---------- Routing regressions ----------
  {
    // "email GV" is never swept up by the phone-call guard (unrelated
    // verb) — confirmed via the intent detector directly. The bare "email
    // <person>" routing gap this text originally documented here has since
    // been fixed in a later patch (see test-post-cp23-email-routing.ts for
    // the full positive/negative/cross-capability coverage of that fix) —
    // "email GV" now correctly reaches Gmail instead of falling through to
    // browser, so this file only asserts the one thing still in its own
    // scope: the call-guard doesn't touch it.
    check('"email GV" is not caught by the phone-call guard (unrelated verb)', !isUnsupportedPhoneCallIntent('email GV'));
    check('"email GV" now correctly reaches Gmail (bare-email fix)', detectGmailIntent('email GV')?.needsBodyClarification === true);
  }
  {
    clearAllPending();
    const r = await runTask({ sessionId: SID, goal: 'draft an email to GV', onEvent: () => {}, taskId: nanoid() });
    check('"draft an email to GV" still reaches the Gmail path', r.capability?.selected === 'gmail', `capability=${r.capability?.selected} result=${r.result}`);
    clearAllPending();
  }
  {
    clearAllPending();
    const r = await runTask({ sessionId: SID, goal: 'schedule a meeting with GV tomorrow at 2 PM', onEvent: () => {}, taskId: nanoid() });
    check(
      '"schedule a meeting with GV tomorrow at 2 PM" still reaches Calendar + Contacts resolution',
      r.capability?.selected === 'calendar' && !!r.resolution,
      `capability=${r.capability?.selected} resolution=${JSON.stringify(r.resolution)}`
    );
    clearAllPending();
  }
  {
    clearAllPending();
    const r = await runTask({ sessionId: SID, goal: 'create a task to call GV tomorrow', onEvent: () => {}, taskId: nanoid() });
    const active = tasksPendingActionStore.active(SID);
    check(
      '"create a task to call GV tomorrow" reaches Tasks — NOT Calendar, NOT the phone-call guard (its own content just happens to contain "call GV")',
      r.capability?.selected === 'tasks' && active?.proposal.title === 'Call GV',
      `capability=${r.capability?.selected} title=${active?.proposal.title} result=${r.result}`
    );
    clearAllPending();
  }

  // ---------- Structural guarantees ----------
  {
    const contactsClientSrc = readFileSync('src/core/capabilities/contacts/client.ts', 'utf-8');
    const maskMatch = /READ_MASK\s*=\s*'([^']+)'/.exec(contactsClientSrc);
    check(
      'Contacts field mask remains exactly names,emailAddresses,organizations — never expanded to phoneNumbers',
      maskMatch?.[1] === 'names,emailAddresses,organizations',
      `mask=${maskMatch?.[1]}`
    );
    const unsupportedSrc = readFileSync('src/core/capabilities/shared/unsupported-intent.ts', 'utf-8');
    check(
      'the unsupported-call guard itself never imports Contacts at all',
      !unsupportedSrc.includes('contacts'),
    );
  }
  {
    // Calendar's create-verb detector must still handle its OWN ordinary
    // phrasing unaffected by the new Tasks-deferral guard.
    const r = detectCalendarIntent('Schedule a meeting with Alice tomorrow at 3 PM for 30 minutes.');
    check('ordinary Calendar create phrasing is unaffected by the new Tasks-deferral guard', r?.operation === 'propose_create', JSON.stringify(r));
    const t = detectTasksIntent('Remind me to call Ramesh tomorrow.');
    check('ordinary Tasks create phrasing (remind me to) is unaffected', t?.operation === 'propose_create', JSON.stringify(t));
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
