/**
 * Checkpoint 27 §Partial failure + §Empty states — a briefing degrades
 * gracefully when one or more sources are unavailable, never silently
 * drops the sources that DID succeed, and honestly reports a genuinely
 * clear day without fabricating priority items.
 */
const TEST_PREFS_PATH = require('os').tmpdir() + '/jarvis-cp27-failure-empty-' + Date.now() + '.json';
process.env.JARVIS_PREFERENCES_PATH = TEST_PREFS_PATH;

process.env.USE_MOCK_GMAIL = 'true';
process.env.USE_MOCK_CALENDAR = 'true';
process.env.USE_MOCK_TASKS = 'true';
process.env.USE_MOCK_CONTACTS = 'true';

import { runBriefing } from '@/core/agent/briefing/runner';
import type { ParsedBriefingIntent } from '@/core/agent/briefing/intent';
import { dayRangeIso } from '@/core/capabilities/calendar/datetime';
import { getTasksClient } from '@/core/capabilities/tasks/resolve';
import { nanoid } from 'nanoid';

const SID = 'test-session-a';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

function scopeForDay(daysFromNow: number, dayLabel = 'today'): ParsedBriefingIntent {
  const range = dayRangeIso(daysFromNow);
  return { kind: 'briefing', scope: { daysFromNow, dayLabel, dayPart: null, rangeStart: range.start, rangeEnd: range.end } };
}

async function main() {
  // ---------- 41. Calendar failure + other sources succeed ----------
  {
    const beforeCal = process.env.USE_MOCK_CALENDAR;
    process.env.USE_MOCK_CALENDAR = 'false';
    const r = await runBriefing(scopeForDay(0), () => {}, undefined, SID, nanoid());
    process.env.USE_MOCK_CALENDAR = beforeCal;
    check('41. Calendar unavailable is honestly reported', r.briefing?.calendarStatus === 'unavailable', `calendarStatus=${r.briefing?.calendarStatus}`);
    check('41b. the OTHER successful sources (Tasks, Gmail) are still reported, not thrown away', r.briefing?.tasksStatus === 'ok' && r.briefing?.gmailStatus === 'ok', `tasksStatus=${r.briefing?.tasksStatus} gmailStatus=${r.briefing?.gmailStatus}`);
    check('41c. the response explicitly names Calendar as unavailable', /Calendar.*wasn't available/i.test(r.result), `result=${r.result.slice(0, 200)}`);
    check('41d. the response still shows real Tasks content despite the Calendar failure', /task/i.test(r.result), `result=${r.result.slice(0, 200)}`);
  }

  // ---------- 42. Tasks failure + other sources succeed ----------
  {
    const beforeTasks = process.env.USE_MOCK_TASKS;
    process.env.USE_MOCK_TASKS = 'false';
    const r = await runBriefing(scopeForDay(0), () => {}, undefined, SID, nanoid());
    process.env.USE_MOCK_TASKS = beforeTasks;
    check('42. Tasks unavailable is honestly reported', r.briefing?.tasksStatus === 'unavailable', `tasksStatus=${r.briefing?.tasksStatus}`);
    check('42b. the OTHER successful sources (Calendar, Gmail) are still reported', r.briefing?.calendarStatus === 'ok' && r.briefing?.gmailStatus === 'ok', `calendarStatus=${r.briefing?.calendarStatus} gmailStatus=${r.briefing?.gmailStatus}`);
    check('42c. the response explicitly names Tasks as unavailable', /Tasks.*wasn't available/i.test(r.result), `result=${r.result.slice(0, 200)}`);
  }

  // ---------- 43. Gmail failure + other sources succeed ----------
  {
    const beforeGmail = process.env.USE_MOCK_GMAIL;
    process.env.USE_MOCK_GMAIL = 'false';
    const r = await runBriefing(scopeForDay(0), () => {}, undefined, SID, nanoid());
    process.env.USE_MOCK_GMAIL = beforeGmail;
    check('43. Gmail unavailable is honestly reported', r.briefing?.gmailStatus === 'unavailable', `gmailStatus=${r.briefing?.gmailStatus}`);
    check('43b. the OTHER successful sources (Calendar, Tasks) are still reported', r.briefing?.calendarStatus === 'ok' && r.briefing?.tasksStatus === 'ok', `calendarStatus=${r.briefing?.calendarStatus} tasksStatus=${r.briefing?.tasksStatus}`);
    check('43c. the response explicitly names Gmail as unavailable, matching the spec\'s own example wording', /Gmail.*wasn't available/i.test(r.result), `result=${r.result.slice(0, 200)}`);
    check('43d. the response is still marked completed overall, not failed — a partial briefing is still a useful result', r.status === 'success' && r.outcome === 'completed');
  }

  // ---------- 44. all three fail honestly ----------
  {
    const before = {
      cal: process.env.USE_MOCK_CALENDAR,
      tasks: process.env.USE_MOCK_TASKS,
      gmail: process.env.USE_MOCK_GMAIL,
    };
    process.env.USE_MOCK_CALENDAR = 'false';
    process.env.USE_MOCK_TASKS = 'false';
    process.env.USE_MOCK_GMAIL = 'false';
    const r = await runBriefing(scopeForDay(0), () => {}, undefined, SID, nanoid());
    process.env.USE_MOCK_CALENDAR = before.cal;
    process.env.USE_MOCK_TASKS = before.tasks;
    process.env.USE_MOCK_GMAIL = before.gmail;
    check(
      '44. all three sources unavailable is reported honestly — never fabricated as a successful/clear briefing',
      r.briefing?.calendarStatus === 'unavailable' && r.briefing?.tasksStatus === 'unavailable' && r.briefing?.gmailStatus === 'unavailable',
      `calendar=${r.briefing?.calendarStatus} tasks=${r.briefing?.tasksStatus} gmail=${r.briefing?.gmailStatus}`
    );
    check('44b. the response says it could not read ANY source, not that the day is clear', /couldn't read any of your sources/i.test(r.result) && !/schedule is clear/i.test(r.result), `result=${r.result}`);
  }

  // ---------- 45. completely clear day ----------
  {
    // A genuinely empty day: day-after-tomorrow has no fixture Calendar
    // events, and day+60 has no fixture Task due there. Gmail's mock
    // fixtures always carry 2 permanently-unread messages (there is no
    // "mark as read" operation on the GmailClient interface at all), so a
    // literal zero-unread-AND-connected Gmail state cannot be constructed
    // — toggling Gmail off instead genuinely means "nothing FROM Gmail
    // contributes to the attention list," which is the honest, achievable
    // form of "clear" here. Calendar/Tasks remain fully connected and
    // genuinely empty, which is the part this test actually exercises.
    // The shared fixture task t8 ("Renew passport") is permanently overdue
    // by construction — complete it first so the default task list is
    // GENUINELY empty of overdue/due items for this test, exactly like
    // CP26's own precedent of adjusting shared mock state via the client's
    // real CRUD methods rather than fabricating a synthetic bypass.
    const tasksClientForClearDay = getTasksClient();
    await tasksClientForClearDay.completeTask(tasksClientForClearDay.defaultListId, 't8');

    const beforeGmail = process.env.USE_MOCK_GMAIL;
    process.env.USE_MOCK_GMAIL = 'false';
    const range = dayRangeIso(2);
    const scope: ParsedBriefingIntent = { kind: 'briefing', scope: { daysFromNow: 2, dayLabel: 'that day', dayPart: null, rangeStart: range.start, rangeEnd: range.end } };
    const r = await runBriefing(scope, () => {}, undefined, SID, nanoid());
    process.env.USE_MOCK_GMAIL = beforeGmail;
    check('45. a completely clear day produces the concise clear-day message, not a fabricated PRIORITY list', /schedule is clear/i.test(r.result) && !r.result.includes('PRIORITY'), `result=${r.result}`);
    check('45b. no priority items were manufactured just to populate the UI', (r.briefing?.attentionCount ?? -1) === 0, `attentionCount=${r.briefing?.attentionCount}`);
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
