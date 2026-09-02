/**
 * Checkpoint 26 §Parsing/routing — recognition of the new/generalized
 * workflow families, the "Alice and Bob" false-split guard, browser
 * never reached for a supported workflow, and unsupported compound steps
 * never silently dropped.
 */
const TEST_PREFS_PATH = require('os').tmpdir() + '/jarvis-cp26-parsing-' + Date.now() + '.json';
process.env.JARVIS_PREFERENCES_PATH = TEST_PREFS_PATH;

process.env.USE_MOCK_GMAIL = 'true';
process.env.USE_MOCK_CALENDAR = 'true';
process.env.USE_MOCK_TASKS = 'true';
process.env.USE_MOCK_CONTACTS = 'true';

import { runTask } from '@/core/agent/task-manager';
import { pendingActionStore } from '@/core/capabilities/gmail/pending-action';
import { calendarPendingActionStore } from '@/core/capabilities/calendar/pending-action';
import { tasksPendingActionStore } from '@/core/capabilities/tasks/pending-action';
import { getCalendarClient } from '@/core/capabilities/calendar/resolve';
import type { ExecutionResult } from '@/core/agent/executor';
import { nanoid } from 'nanoid';

const SID = 'test-session-a';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

function clearAll(sid: string) {
  pendingActionStore.clear(sid);
  calendarPendingActionStore.clear(sid);
  tasksPendingActionStore.clear(sid);
}

function browserWasInvoked(r: ExecutionResult): boolean {
  return r.events.some((e) => e.type === 'browser.initialized');
}

async function seedMeetingWithAlice(daysFromNow = 1, hour = 14) {
  const client = getCalendarClient();
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() + daysFromNow, hour, 0, 0, 0);
  const end = new Date(start.getTime() + 30 * 60000);
  await client.createEvent({ kind: 'create', title: 'Coffee with Alice', start: start.toISOString(), end: end.toISOString(), timezone: 'UTC', attendees: ['alice@example.com'] });
}

async function main() {
  clearAll(SID);

  // ---------- 1. Gmail -> Tasks recognized ----------
  {
    clearAll(SID);
    const r = await runTask({ sessionId: SID, goal: 'Find my latest email from John and remind me to reply tomorrow.', onEvent: () => {}, taskId: nanoid() });
    check(
      '1. Gmail -> Tasks workflow recognized',
      r.capability?.selected === 'orchestration' && r.orchestration?.pattern === 'gmail-then-task-reply' && r.orchestration?.steps.length === 2,
      `pattern=${r.orchestration?.pattern} result=${r.result.slice(0, 100)}`
    );
    clearAll(SID);
  }

  // ---------- 2. Calendar -> Tasks recognized ----------
  {
    clearAll(SID);
    const r = await runTask({ sessionId: SID, goal: 'Find my last meeting tomorrow and remind me to send notes afterward.', onEvent: () => {}, taskId: nanoid() });
    check(
      '2. Calendar -> Tasks workflow recognized',
      r.capability?.selected === 'orchestration' && r.orchestration?.pattern === 'calendar-last-first-then-task',
      `pattern=${r.orchestration?.pattern} result=${r.result.slice(0, 100)}`
    );
    clearAll(SID);
  }
  {
    clearAll(SID);
    const r = await runTask({ sessionId: SID, goal: 'Check my first meeting tomorrow and create a task to prepare before it.', onEvent: () => {}, taskId: nanoid() });
    check(
      '2b. Calendar -> Tasks workflow recognized (alternate phrasing: "create a task to")',
      r.capability?.selected === 'orchestration' && r.orchestration?.pattern === 'calendar-last-first-then-task',
      `pattern=${r.orchestration?.pattern} result=${r.result.slice(0, 100)}`
    );
    clearAll(SID);
  }

  // ---------- 3. Calendar -> Gmail recognized ----------
  {
    clearAll(SID);
    await seedMeetingWithAlice();
    const r = await runTask({ sessionId: SID, goal: "Find my meeting with Alice tomorrow and draft her an email saying I'll be there.", onEvent: () => {}, taskId: nanoid() });
    check(
      '3. Calendar -> Gmail workflow recognized',
      r.capability?.selected === 'orchestration' && r.orchestration?.pattern === 'calendar-meeting-then-gmail',
      `pattern=${r.orchestration?.pattern} result=${r.result.slice(0, 150)}`
    );
    clearAll(SID);
  }
  {
    clearAll(SID);
    await seedMeetingWithAlice();
    const r = await runTask({ sessionId: SID, goal: 'Check my next meeting with Alice and email her asking if 3 PM works.', onEvent: () => {}, taskId: nanoid() });
    check(
      '3b. Calendar -> Gmail workflow recognized (alternate phrasing: "email her asking")',
      r.capability?.selected === 'orchestration' && r.orchestration?.pattern === 'calendar-meeting-then-gmail',
      `pattern=${r.orchestration?.pattern} result=${r.result.slice(0, 150)}`
    );
    clearAll(SID);
  }

  // ---------- 4. Calendar -> Gmail -> Tasks recognized ----------
  {
    clearAll(SID);
    await seedMeetingWithAlice();
    const r = await runTask({
      sessionId: SID,
      goal: "Find my meeting with Alice tomorrow, draft her an email saying I'll be there, and remind me to send the notes Friday.",
      onEvent: () => {},
      taskId: nanoid(),
    });
    check(
      '4. Calendar -> Gmail -> Tasks workflow recognized (3 steps)',
      r.capability?.selected === 'orchestration' && r.orchestration?.pattern === 'calendar-gmail-tasks-chain' && r.orchestration?.steps.length === 3,
      `pattern=${r.orchestration?.pattern} steps=${r.orchestration?.steps.length} result=${r.result.slice(0, 200)}`
    );
    clearAll(SID);
  }

  // ---------- 5. Calendar + Tasks combined read preserved ----------
  {
    clearAll(SID);
    const r = await runTask({ sessionId: SID, goal: "What's on my calendar and task list today?", onEvent: () => {}, taskId: nanoid() });
    check(
      '5. Calendar + Tasks combined read preserved (CP21 behavior unaffected)',
      r.capability?.selected === 'orchestration' && r.orchestration?.pattern === 'calendar-tasks-summary' && !browserWasInvoked(r),
      `pattern=${r.orchestration?.pattern} result=${r.result.slice(0, 100)}`
    );
    clearAll(SID);
  }

  // ---------- 6. "Alice and Bob" inside one Calendar attendee phrase does not split ----------
  {
    clearAll(SID);
    const r = await runTask({ sessionId: SID, goal: 'Schedule lunch with Alice and Bob tomorrow at noon.', onEvent: () => {}, taskId: nanoid() });
    check(
      '6. "Schedule lunch with Alice and Bob tomorrow" is ONE Calendar operation, not split into a workflow',
      r.capability?.selected === 'calendar',
      `capability=${r.capability?.selected} orchestrationPattern=${r.orchestration?.pattern} result=${r.result}`
    );
    clearAll(SID);
  }

  // ---------- 7. supported workflow never reaches browser ----------
  {
    clearAll(SID);
    await seedMeetingWithAlice();
    const r = await runTask({
      sessionId: SID,
      goal: "Find my meeting with Alice tomorrow, draft her an email saying I'll be there, and remind me to send the notes Friday.",
      onEvent: () => {},
      taskId: nanoid(),
    });
    check('7. the 3-step supported workflow never opens the browser/OmniRoute planner', !browserWasInvoked(r) && r.capability?.selected !== 'browser', `capability=${r.capability?.selected}`);
    clearAll(SID);
  }
  {
    clearAll(SID);
    const r = await runTask({ sessionId: SID, goal: 'Find my latest email from John and remind me to reply tomorrow.', onEvent: () => {}, taskId: nanoid() });
    check('7b. the Gmail -> Tasks workflow never opens the browser/OmniRoute planner', !browserWasInvoked(r) && r.capability?.selected !== 'browser');
    clearAll(SID);
  }

  // ---------- 8. unsupported compound step not silently dropped ----------
  {
    clearAll(SID);
    const before = pendingActionStore.active(SID);
    const r = await runTask({ sessionId: SID, goal: 'Check my email and transfer $500 to my landlord.', onEvent: () => {}, taskId: nanoid() });
    check(
      '8. "Check my email and transfer $500" — the unsupported half is reported explicitly, NOT silently narrowed to just the Gmail read',
      r.outcome === 'blocked' && /transfer \$500/i.test(r.result) && r.capability?.selected !== 'gmail',
      `capability=${r.capability?.selected} outcome=${r.outcome} result=${r.result}`
    );
    check('8b. no Gmail read was silently performed and reported as the whole result', before === pendingActionStore.active(SID));
    clearAll(SID);
  }
  {
    // A second, differently-shaped example of the same principle.
    clearAll(SID);
    const r = await runTask({ sessionId: SID, goal: 'Check my calendar and wire $1000 to Acme Corp.', onEvent: () => {}, taskId: nanoid() });
    check(
      '8c. "Check my calendar and wire $1000" is also reported as unsupported, not silently narrowed to Calendar',
      r.outcome === 'blocked' && /wire \$1000/i.test(r.result),
      `result=${r.result}`
    );
    clearAll(SID);
  }

  // ---------- 8d-8h. CP26 architecture review — unsupported-action regex false-positive guard ----------
  // The `$` in UNSUPPORTED_ACTION_RE is REQUIRED, specifically so ordinary
  // phrases that happen to contain one of the curated verbs ("order",
  // "pay", "purchase") near an unrelated number are never misidentified
  // as an unsupported financial action and wrongly blocked.
  {
    clearAll(SID);
    const r = await runTask({ sessionId: SID, goal: 'Find my email about order 500', onEvent: () => {}, taskId: nanoid() });
    check(
      '8d. "Find my email about order 500" is NOT misidentified as an unsupported action (an order number, not a purchase)',
      r.orchestration?.pattern !== 'unsupported-action',
      `pattern=${r.orchestration?.pattern} outcome=${r.outcome} capability=${r.capability?.selected}`
    );
    clearAll(SID);
  }
  {
    clearAll(SID);
    const r = await runTask({ sessionId: SID, goal: "What's on my calendar at 5", onEvent: () => {}, taskId: nanoid() });
    check(
      '8e. "What\'s on my calendar at 5" is NOT misidentified as an unsupported action',
      r.orchestration?.pattern !== 'unsupported-action',
      `pattern=${r.orchestration?.pattern} outcome=${r.outcome} capability=${r.capability?.selected}`
    );
    clearAll(SID);
  }
  {
    clearAll(SID);
    const r = await runTask({ sessionId: SID, goal: 'Find invoice 500', onEvent: () => {}, taskId: nanoid() });
    check(
      '8f. "Find invoice 500" is NOT misidentified as an unsupported action',
      r.orchestration?.pattern !== 'unsupported-action',
      `pattern=${r.orchestration?.pattern} outcome=${r.outcome} capability=${r.capability?.selected}`
    );
    clearAll(SID);
  }
  {
    clearAll(SID);
    const r = await runTask({ sessionId: SID, goal: "What's my order number 500", onEvent: () => {}, taskId: nanoid() });
    check(
      '8g. "What\'s my order number 500" is NOT misidentified as an unsupported action',
      r.orchestration?.pattern !== 'unsupported-action',
      `pattern=${r.orchestration?.pattern} outcome=${r.outcome} capability=${r.capability?.selected}`
    );
    clearAll(SID);
  }
  {
    // The regex still catches the checkpoint's own required shape even
    // with a different curated verb ("purchase") — proves the `$`
    // requirement narrows false positives without weakening true positives.
    clearAll(SID);
    const r = await runTask({ sessionId: SID, goal: 'Check my email and purchase $200 worth of supplies.', onEvent: () => {}, taskId: nanoid() });
    check(
      '8h. "Check my email and purchase $200" is still correctly reported as unsupported (true positive preserved)',
      r.outcome === 'blocked' && /purchase \$200/i.test(r.result),
      `result=${r.result}`
    );
    clearAll(SID);
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
