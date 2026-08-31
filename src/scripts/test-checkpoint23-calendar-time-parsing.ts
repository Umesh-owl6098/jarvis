/**
 * Checkpoint 23 fix — regression coverage for the resolveClockTime() parser
 * bug discovered during CP23 acceptance: a LEADING duration adjective
 * ("a 60 minute meeting") was being read as an hour-of-day (60 > 23,
 * rejected outright) before the parser ever reached the real "at 2 PM"
 * later in the same sentence. Fixed structurally in
 * calendar/datetime.ts's resolveClockTime() — scans every candidate and
 * prefers one with an explicit signal (am/pm, or an immediately-preceding
 * "at") over an implausible/signal-less one, rather than special-casing
 * any particular number.
 */
process.env.USE_MOCK_GMAIL = 'true';
process.env.USE_MOCK_CALENDAR = 'true';
process.env.USE_MOCK_TASKS = 'true';
process.env.USE_MOCK_CONTACTS = 'true';

const TEST_DIR_PATH = require('os').tmpdir() + '/jarvis-cp23-timefix-' + Date.now() + '.json';
process.env.JARVIS_PREFERENCES_PATH = TEST_DIR_PATH;

import { resolveClockTime, resolveDurationMinutes, resolveDayPhrase } from '@/core/capabilities/calendar/datetime';
import { runTask } from '@/core/agent/task-manager';
import { calendarPendingActionStore } from '@/core/capabilities/calendar/pending-action';
import { preferencesStore } from '@/core/preferences/store';
import { getCalendarClient } from '@/core/capabilities/calendar/resolve';
import { nanoid } from 'nanoid';
import { rmSync } from 'fs';

const SID = 'test-session';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

async function main() {
  // ---------- Required regression cases (parser-level) ----------
  {
    const c = resolveClockTime('Schedule a 60 minute meeting tomorrow at 2 PM');
    check('R1. "60 minute meeting ... at 2 PM" -> clock is 2 PM (14:00), not 60', c?.hour === 14 && c?.minute === 0, JSON.stringify(c));
    check('R1b. duration is 60', resolveDurationMinutes('Schedule a 60 minute meeting tomorrow at 2 PM') === 60);
  }
  {
    const c = resolveClockTime('Schedule a 30 minute meeting tomorrow at 9 AM');
    check('R2. "30 minute meeting ... at 9 AM" -> clock is 9 AM (9:00)', c?.hour === 9 && c?.minute === 0, JSON.stringify(c));
    check('R2b. duration is 30', resolveDurationMinutes('Schedule a 30 minute meeting tomorrow at 9 AM') === 30);
  }
  {
    const c = resolveClockTime('Schedule a 90 minute meeting Friday at 3:30 PM');
    check('R3. "90 minute meeting Friday at 3:30 PM" -> clock is 15:30', c?.hour === 15 && c?.minute === 30, JSON.stringify(c));
    check('R3b. duration is 90', resolveDurationMinutes('Schedule a 90 minute meeting Friday at 3:30 PM') === 90);
  }
  {
    const c = resolveClockTime('Schedule a meeting tomorrow at 2 PM for 60 minutes');
    check('R4. trailing-duration phrasing unchanged -> clock is 2 PM', c?.hour === 14 && c?.minute === 0, JSON.stringify(c));
    check('R4b. duration is 60', resolveDurationMinutes('Schedule a meeting tomorrow at 2 PM for 60 minutes') === 60);
  }
  {
    const c = resolveClockTime('Schedule a meeting tomorrow at 2');
    check('R5. bare "at 2" (no am/pm, no duration) preserves existing semantics -> 2:00', c?.hour === 2 && c?.minute === 0, JSON.stringify(c));
    check('R5b. no duration parsed', resolveDurationMinutes('Schedule a meeting tomorrow at 2') === null);
  }
  {
    const c = resolveClockTime('Schedule a meeting for 30 minutes tomorrow at 4');
    check('R6. leading duration + bare trailing "at 4" -> clock resolves to 4:00, not rejected', c?.hour === 4 && c?.minute === 0, JSON.stringify(c));
    check('R6b. duration is 30', resolveDurationMinutes('Schedule a meeting for 30 minutes tomorrow at 4') === 30);
  }

  // ---------- Opposite-direction regression: duration detection must not steal clock expressions ----------
  {
    check(
      'O1. a bare clock time alone ("at 2 PM") is never misread as a duration',
      resolveDurationMinutes('Schedule a meeting tomorrow at 2 PM') === null
    );
    check(
      'O2. ":30" in a clock time ("at 3:30 PM") is never misread as a 30-minute duration',
      resolveDurationMinutes('Schedule a meeting Friday at 3:30 PM') === null
    );
    const c = resolveClockTime('Am I free tomorrow at 3 PM');
    check('O3. freebusy-style "at 3 PM" still resolves normally (unrelated call site, same function)', c?.hour === 15 && c?.minute === 0, JSON.stringify(c));
  }

  // ---------- End-to-end: existing Calendar create/update/list phrasings still work ----------
  {
    calendarPendingActionStore.clear(SID);
    const r = await runTask({ sessionId: SID, goal: 'Schedule a meeting with Alice tomorrow at 3 PM for 30 minutes.', onEvent: () => {}, taskId: nanoid() });
    const active = calendarPendingActionStore.active(SID);
    const minutes = active ? (new Date(active.proposal.end).getTime() - new Date(active.proposal.start).getTime()) / 60000 : null;
    check(
      'E1. ordinary trailing-duration create phrasing still produces a correct proposal (regression, unrelated to the fix)',
      r.capability?.selected === 'calendar' && minutes === 30 && /3:00 PM/.test(r.result),
      `result=${r.result}`
    );
    calendarPendingActionStore.clear(SID);
  }
  {
    const r = await runTask({ sessionId: SID, goal: 'What meetings do I have tomorrow?', onEvent: () => {}, taskId: nanoid() });
    check('E2. ordinary Calendar list phrasing is unaffected', r.capability?.selected === 'calendar' && r.status === 'success', `result=${r.result?.slice(0, 80)}`);
  }
  {
    const r = await runTask({ sessionId: SID, goal: 'Move my dentist appointment to 5 PM.', onEvent: () => {}, taskId: nanoid() });
    check('E3. ordinary Calendar update phrasing (newTimeFrom/oldTimeFrom, both built on resolveClockTime) is unaffected', r.capability?.selected === 'calendar', `result=${r.result?.slice(0, 120)}`);
    calendarPendingActionStore.clear(SID);
  }

  // ---------- CP23 precedence test, with the now-fixed leading-duration phrasing ----------
  {
    preferencesStore.forgetAll();
    await runTask({ sessionId: SID, goal: 'Remember that I prefer 30 minute meetings.', onEvent: () => {}, taskId: nanoid() });
    calendarPendingActionStore.clear(SID);

    const calClient = getCalendarClient();
    const before = (await calClient.listEvents(new Date(0).toISOString(), new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString(), 'UTC', 200)).length;

    const rExplicit = await runTask({ sessionId: SID, goal: 'Schedule a 60 minute meeting tomorrow at 2 PM', onEvent: () => {}, taskId: nanoid() });
    const explicitActive = calendarPendingActionStore.active(SID);
    const explicitMinutes = explicitActive ? (new Date(explicitActive.proposal.end).getTime() - new Date(explicitActive.proposal.start).getTime()) / 60000 : null;
    check(
      'P1. "Schedule a 60 minute meeting tomorrow at 2 PM" with a stored 30-min preference -> start 2 PM, duration 60 (explicit wins), NO stored-default annotation, proposal only',
      explicitMinutes === 60 &&
        /2:00 PM/.test(rExplicit.result) &&
        !/using your stored default/i.test(rExplicit.result) &&
        !!explicitActive,
      `minutes=${explicitMinutes} start=${explicitActive?.proposal.start} result=${rExplicit.result}`
    );
    calendarPendingActionStore.clear(SID);

    const rDefaulted = await runTask({ sessionId: SID, goal: 'Schedule a meeting tomorrow at 2 PM', onEvent: () => {}, taskId: nanoid() });
    const defaultedActive = calendarPendingActionStore.active(SID);
    const defaultedMinutes = defaultedActive ? (new Date(defaultedActive.proposal.end).getTime() - new Date(defaultedActive.proposal.start).getTime()) / 60000 : null;
    check(
      'P2. "Schedule a meeting tomorrow at 2 PM" (no duration) -> start 2 PM, duration 30 (stored default), WITH annotation, proposal only',
      defaultedMinutes === 30 && /2:00 PM/.test(rDefaulted.result) && /using your stored default/i.test(rDefaulted.result),
      `minutes=${defaultedMinutes} start=${defaultedActive?.proposal.start} result=${rDefaulted.result}`
    );
    calendarPendingActionStore.clear(SID);

    const after = (await calClient.listEvents(new Date(0).toISOString(), new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString(), 'UTC', 200)).length;
    check('P3. no real Calendar mutation occurred from either proposal', after === before, `before=${before} after=${after}`);

    preferencesStore.forgetAll();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  try { rmSync(TEST_DIR_PATH, { force: true }); } catch {}
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error('Fatal error:', e);
  try { rmSync(TEST_DIR_PATH, { force: true }); } catch {}
  process.exit(1);
});
