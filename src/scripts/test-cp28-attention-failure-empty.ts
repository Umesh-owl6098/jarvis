/**
 * Checkpoint 28 §Failure/empty — Calendar, Tasks, and Gmail fail
 * independently, a partial failure never gets reported as "nothing
 * urgent," an all-three failure is honest, and a genuinely quiet/clear
 * state is reported concisely without fabricating urgency.
 */
const TEST_PREFS_PATH = require('os').tmpdir() + '/jarvis-cp28-failure-empty-' + Date.now() + '.json';
process.env.JARVIS_PREFERENCES_PATH = TEST_PREFS_PATH;

process.env.USE_MOCK_GMAIL = 'true';
process.env.USE_MOCK_CALENDAR = 'true';
process.env.USE_MOCK_TASKS = 'true';
process.env.USE_MOCK_CONTACTS = 'true';

import { runAttentionCheck } from '@/core/agent/attention/runner';
import type { ParsedAttentionIntent } from '@/core/agent/attention/intent';
import { getTasksClient } from '@/core/capabilities/tasks/resolve';
import { nanoid } from 'nanoid';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const SID = 'test-session-a';
const rightNowScope: ParsedAttentionIntent = {
  kind: 'attention',
  scope: { kind: 'right_now', label: 'right now', rangeStart: new Date().toISOString(), rangeEnd: new Date(Date.now() + 3600000).toISOString(), tasksDayOffset: 0 },
};

async function main() {
  // ---------- 1. Calendar failure + others succeed ----------
  {
    const before = process.env.USE_MOCK_CALENDAR;
    process.env.USE_MOCK_CALENDAR = 'false';
    const r = await runAttentionCheck(rightNowScope, () => {}, undefined, SID, nanoid());
    process.env.USE_MOCK_CALENDAR = before;
    check('1. Calendar unavailable is honestly reported', r.attention?.calendarStatus === 'unavailable', `calendarStatus=${r.attention?.calendarStatus}`);
    check('1b. the OTHER successful sources (Tasks, Gmail) are still reported, not thrown away', r.attention?.tasksStatus === 'ok' && r.attention?.gmailStatus === 'ok');
    check('1c. the response explicitly names Calendar as unavailable', /Calendar wasn't available/i.test(r.result), `result=${r.result.slice(0, 200)}`);
  }

  // ---------- 2. Tasks failure + others succeed ----------
  {
    const before = process.env.USE_MOCK_TASKS;
    process.env.USE_MOCK_TASKS = 'false';
    const r = await runAttentionCheck(rightNowScope, () => {}, undefined, SID, nanoid());
    process.env.USE_MOCK_TASKS = before;
    check('2. Tasks unavailable is honestly reported', r.attention?.tasksStatus === 'unavailable');
    check('2b. the OTHER successful sources (Calendar, Gmail) are still reported', r.attention?.calendarStatus === 'ok' && r.attention?.gmailStatus === 'ok');
    check('2c. the response explicitly names Tasks as unavailable', /Tasks wasn't available/i.test(r.result), `result=${r.result.slice(0, 200)}`);
  }

  // ---------- 3. Gmail failure + others succeed ----------
  {
    const before = process.env.USE_MOCK_GMAIL;
    process.env.USE_MOCK_GMAIL = 'false';
    const r = await runAttentionCheck(rightNowScope, () => {}, undefined, SID, nanoid());
    process.env.USE_MOCK_GMAIL = before;
    check('3. Gmail unavailable is honestly reported', r.attention?.gmailStatus === 'unavailable');
    check('3b. the OTHER successful sources (Calendar, Tasks) are still reported', r.attention?.calendarStatus === 'ok' && r.attention?.tasksStatus === 'ok');
    check('3c. Gmail unavailable is NEVER silently reinterpreted as "no important email" — it is explicitly named as unavailable', /Gmail wasn't available/i.test(r.result), `result=${r.result.slice(0, 200)}`);
    check('3d. the response is still a completed result overall — a partial check is still useful', r.status === 'success' && r.outcome === 'completed');
  }

  // ---------- 4. multiple failures ----------
  {
    const beforeCal = process.env.USE_MOCK_CALENDAR;
    const beforeGmail = process.env.USE_MOCK_GMAIL;
    process.env.USE_MOCK_CALENDAR = 'false';
    process.env.USE_MOCK_GMAIL = 'false';
    const r = await runAttentionCheck(rightNowScope, () => {}, undefined, SID, nanoid());
    process.env.USE_MOCK_CALENDAR = beforeCal;
    process.env.USE_MOCK_GMAIL = beforeGmail;
    check('4. two simultaneous failures (Calendar + Gmail) are both honestly reported', r.attention?.calendarStatus === 'unavailable' && r.attention?.gmailStatus === 'unavailable' && r.attention?.tasksStatus === 'ok');
    check('4b. the response names both unavailable sources', /Calendar wasn't available/i.test(r.result) && /Gmail wasn't available/i.test(r.result), `result=${r.result}`);
  }

  // ---------- 5. all-three failure is honest ----------
  {
    const before = { cal: process.env.USE_MOCK_CALENDAR, tasks: process.env.USE_MOCK_TASKS, gmail: process.env.USE_MOCK_GMAIL };
    process.env.USE_MOCK_CALENDAR = 'false';
    process.env.USE_MOCK_TASKS = 'false';
    process.env.USE_MOCK_GMAIL = 'false';
    const r = await runAttentionCheck(rightNowScope, () => {}, undefined, SID, nanoid());
    process.env.USE_MOCK_CALENDAR = before.cal;
    process.env.USE_MOCK_TASKS = before.tasks;
    process.env.USE_MOCK_GMAIL = before.gmail;
    check('5. all three sources unavailable is reported honestly, never fabricated as "nothing urgent"', r.attention?.calendarStatus === 'unavailable' && r.attention?.tasksStatus === 'unavailable' && r.attention?.gmailStatus === 'unavailable');
    check('5b. the response says it could not check ANY source', /couldn't check any of your sources/i.test(r.result), `result=${r.result}`);
    check('5c. the response never claims "nothing urgent" when nothing was actually checked', !/^Nothing urgent right now\.$/.test(r.result.trim()), `result=${r.result}`);
  }

  // ---------- 6. genuinely empty (a real clear window) ----------
  {
    // A day-4-out scope has no fixture Calendar events and (once the
    // permanently-overdue fixture task t8 is completed) no overdue/due
    // tasks either. Gmail's 2 fixture messages are permanently unread (no
    // "mark read" operation exists on GmailClient), so — mirroring CP27's
    // own precedent exactly — Gmail is toggled off for this ONE test to
    // reach the genuinely-empty branch honestly, rather than fabricating a
    // "zero unread" state that isn't real.
    const tasksClient = getTasksClient();
    await tasksClient.completeTask(tasksClient.defaultListId, 't8');
    const beforeGmail = process.env.USE_MOCK_GMAIL;
    process.env.USE_MOCK_GMAIL = 'false';
    const farScope: ParsedAttentionIntent = { kind: 'attention', scope: { kind: 'day', label: 'that day', rangeStart: new Date(Date.now() + 4 * 86400000).toISOString(), rangeEnd: new Date(Date.now() + 5 * 86400000).toISOString(), tasksDayOffset: 90 } };
    const r = await runAttentionCheck(farScope, () => {}, undefined, SID, nanoid());
    process.env.USE_MOCK_GMAIL = beforeGmail;
    // Gmail was deliberately toggled off for this test, so the correct,
    // honest response uses the degrade-aware phrasing (matching the
    // spec's own example: "I didn't find anything urgent in Calendar or
    // Tasks, but Gmail wasn't available.") — NOT the plain "Nothing
    // urgent right now." wording, which is reserved for when every source
    // actually succeeded. This is the concise, honest empty-state text.
    check(
      '6. a genuinely empty/clear Calendar+Tasks state (with Gmail degraded) reports the honest degrade-aware empty phrasing, concisely, with no fabricated urgency',
      /didn't find anything urgent in Calendar and Tasks/i.test(r.result) && /Gmail wasn't available/i.test(r.result),
      `result=${r.result}`
    );
    check('6b. no urgent items were manufactured just to populate a response', r.attention?.urgentCount === 0, `urgentCount=${r.attention?.urgentCount}`);
  }

  // ---------- 7. nonurgent-upcoming-only (nothing urgent, but later things exist) ----------
  {
    const { getCalendarClient } = await import('@/core/capabilities/calendar/resolve');
    const calClient = getCalendarClient();
    const start = new Date(Date.now() + 3 * 3600000); // 3h out — beyond "right now" (60min), so NOT urgent
    await calClient.createEvent({ kind: 'create', title: 'CP28 Nonurgent Later Meeting', start: start.toISOString(), end: new Date(start.getTime() + 1800000).toISOString(), timezone: 'UTC', attendees: [] });
    const soonScope: ParsedAttentionIntent = { kind: 'attention', scope: { kind: 'soon', label: 'soon', rangeStart: new Date().toISOString(), rangeEnd: new Date(Date.now() + 240 * 60000).toISOString(), tasksDayOffset: 0 } };
    const r = await runAttentionCheck(soonScope, () => {}, undefined, SID, nanoid());
    check('7. nothing urgent, but a later item exists — reported as "Nothing urgent" PLUS a coming-up count, never silently dropped', /Nothing urgent right now\./.test(r.result) && /coming up/i.test(r.result), `result=${r.result}`);
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
