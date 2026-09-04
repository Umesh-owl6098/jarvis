/**
 * Post-Checkpoint-20 robustness fix — regression coverage for the
 * concept+shape classifier (capabilities/shared/query-shape.ts) that
 * replaced per-sentence regex patching in gmail/calendar/tasks intent.ts.
 *
 * Root cause this guards against: "What are all the emails I got today"
 * (the exact sentence that failed manual verification through the real
 * localhost:3000 Command Channel) and a growing list of equally natural
 * paraphrases were never covered by exact-sentence-shape regexes. Adding
 * one regex per sentence doesn't scale — this classifier separates WHAT a
 * sentence concerns (a capability's own concept vocabulary) from HOW it's
 * phrased (a shared interrogative/imperative query-shape check), so new
 * natural phrasings of the SAME request are covered by construction, not
 * by enumeration.
 *
 * Every case here goes through runTask() — the exact function
 * src/app/api/agent/stream/route.ts calls for the real Command Channel —
 * and asserts BOTH the resulting capability AND that no 'browser.initialized'
 * event was ever emitted, proving Playwright/the browser subsystem was
 * never started for these direct-capability requests.
 */
process.env.USE_MOCK_GMAIL = 'true';
process.env.USE_MOCK_CALENDAR = 'true';
process.env.USE_MOCK_TASKS = 'true';

import { runTask } from '@/core/agent/task-manager';
import { nanoid } from 'nanoid';
import type { ExecutionResult } from '@/core/agent/executor';
import { OmniRouteClient, type GenerateRequest, type GenerateResponse } from '@/core/router/client';

// CP29 HOLD — this file's own negative examples ("What is a calendar?" and
// siblings) are DELIBERATELY not claimed by any deterministic capability,
// so runTask() falls through to the real browser/OmniRoute planner —
// exactly what those assertions want to prove (r.capability !== 'gmail'/
// 'calendar'/'tasks'). But that makes this pre-existing (CP20-era) script
// depend on live OmniRoute reachability/rate limits, which CP28 already
// established the deterministic baseline must not do. Every OTHER
// assertion in this file is claimed deterministically before ever
// reaching the browser (unaffected either way), so it is safe to stub
// OmniRouteClient.prototype.generateForPlanning for the WHOLE file — the
// exact same test-only technique already used for
// test-checkpoint17-gmail-security.ts's own OmniRoute dependency. Zero
// production code is touched: only the class's own prototype method is
// replaced for the duration of THIS process, and restored at the end.
// The stub deterministically returns a valid planner "fail" action on the
// FIRST call — never "use_skill" — so the executor terminates in exactly
// one step (no retry loop, no real HTTP request of any kind), still
// leaving capability.selected as 'browser', which is all these negative
// assertions ever check.
const originalGenerateForPlanning = OmniRouteClient.prototype.generateForPlanning;
OmniRouteClient.prototype.generateForPlanning = async function (_request: GenerateRequest): Promise<GenerateResponse> {
  return {
    content: JSON.stringify({ action: 'fail', reason: 'No concrete, resolvable destination for this deterministic test.' }),
    model: 'test-deterministic-stub',
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    provider: 'test-stub',
    cost: 0,
  };
};

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

async function expectCapability(goal: string, capability: string, label: string) {
  const r = await runTask({ sessionId: SID, goal, onEvent: () => {}, taskId: nanoid() });
  check(
    `${label}: "${goal}" -> ${capability}, browser never invoked`,
    r.capability?.selected === capability && !browserWasInvoked(r),
    `capability=${r.capability?.selected} browserInvoked=${browserWasInvoked(r)}`
  );
}

async function main() {
  // ---------- the exact sentence that failed manual verification ----------
  await expectCapability('What are all the emails I got today', 'gmail', 'REPORTED FAILURE');

  // ---------- Gmail paraphrases ----------
  console.log('\n=== Gmail paraphrases ===');
  for (const goal of [
    'What emails did I get today?',
    'What are all the emails I got today?',
    'Show me all emails from today',
    'Did I get any emails today?',
    'Any new emails today?',
    "What's my latest email?",
    'Who emailed me today?',
    'What did John email me?',
  ]) {
    await expectCapability(goal, 'gmail', 'GMAIL');
  }

  // ---------- Calendar paraphrases ----------
  console.log('\n=== Calendar paraphrases ===');
  for (const goal of [
    'Do I have anything on my calendar today?',
    'What meetings do I have tomorrow?',
    "What's my schedule today?",
    'Any meetings today?',
    'Do I have any events tomorrow?',
    'What does my calendar look like today?',
    'What do I have today?',
  ]) {
    await expectCapability(goal, 'calendar', 'CALENDAR');
  }

  // ---------- Tasks paraphrases ----------
  console.log('\n=== Tasks paraphrases ===');
  for (const goal of [
    'What tasks do I have today?',
    'What do I need to do tomorrow?',
    'Any new tasks today?',
    // 'Show my reminders' moved to Checkpoint 29's own reminder-listing
    // grammar (see test-cp29-reminders-intent.ts) — CP29 deliberately and
    // explicitly reclassifies "reminder"-vocabulary list/next/cancel
    // phrases to the new Reminders capability, checked before Tasks in
    // task-manager.ts specifically so this phrase wins the collision (see
    // task-manager.ts's own comment at the reminder-intent dispatch site).
    // Tasks' own bare "remind me to X" (no time) creation trigger and its
    // "task"-vocabulary paraphrases below are completely unaffected.
    'Did I get any tasks today?',
    'What is on my to-do list today?',
  ]) {
    await expectCapability(goal, 'tasks', 'TASKS');
  }

  // ---------- negative/collision cases: broader matching must not steal genuine browser requests ----------
  console.log('\n=== negative: genuine browser/informational requests stay on browser ===');
  {
    const r = await runTask({ sessionId: SID, goal: 'What is email marketing?', onEvent: () => {}, taskId: nanoid() });
    check(
      'NEG. "What is email marketing?" never claimed by Gmail (no personal/temporal signal)',
      r.capability?.selected !== 'gmail',
      `capability=${r.capability?.selected}`
    );
  }
  {
    const r = await runTask({ sessionId: SID, goal: 'What is a calendar?', onEvent: () => {}, taskId: nanoid() });
    check(
      'NEG. "What is a calendar?" never claimed by Calendar (no personal/temporal signal)',
      r.capability?.selected !== 'calendar',
      `capability=${r.capability?.selected}`
    );
  }
  {
    const r = await runTask({ sessionId: SID, goal: 'What is a task manager?', onEvent: () => {}, taskId: nanoid() });
    check(
      'NEG. "What is a task manager?" never claimed by Tasks (no personal/temporal signal)',
      r.capability?.selected !== 'tasks',
      `capability=${r.capability?.selected}`
    );
  }

  // ---------- negative: Gmail draft BODY containing Calendar/Tasks concept+shape language stays Gmail ----------
  console.log('\n=== negative: Gmail draft body regression ===');
  for (const goal of [
    'Draft an email to Alice saying do I have anything on my calendar today',
    'Draft an email to Alice saying what tasks do I have today',
    'Draft an email to Bob saying any new emails today',
    'Draft an email to Carol saying what did John email me',
  ]) {
    await expectCapability(goal, 'gmail', 'NEG-DRAFT-BODY');
  }

  // ---------- negative: Calendar/Tasks vocabulary distinction still holds under the new classifier ----------
  console.log('\n=== negative: Calendar-vs-Tasks distinction still holds ===');
  await expectCapability('Schedule a meeting tomorrow at 3 PM for 30 minutes.', 'calendar', 'NEG-CAL-VS-TASKS');
  await expectCapability('Remind me to submit the report tomorrow.', 'tasks', 'NEG-CAL-VS-TASKS');

  console.log(`\n${pass} passed, ${fail} failed`);
  OmniRouteClient.prototype.generateForPlanning = originalGenerateForPlanning;
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => {
  OmniRouteClient.prototype.generateForPlanning = originalGenerateForPlanning;
  console.error('FATAL', e);
  process.exit(1);
});
