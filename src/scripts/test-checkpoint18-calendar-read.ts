/**
 * Checkpoint 18 §27 — Calendar read tests A, B, C, J against the
 * deterministic mock calendar (mirrors the Gmail mock-test philosophy).
 */
process.env.USE_MOCK_CALENDAR = 'true';

import { runTask } from '@/core/agent/task-manager';
import { calendarPendingActionStore } from '@/core/capabilities/calendar/pending-action';
import { nanoid } from 'nanoid';

const SID = 'test-session';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

async function main() {
  calendarPendingActionStore.clear(SID);

  // ---------- A: list events ----------
  {
    const r = await runTask({ sessionId: SID, goal: 'What do I have today?', onEvent: () => {}, taskId: nanoid() });
    check(
      'A. list today — completes via Calendar capability, no browser',
      r.status === 'success' && r.capability?.selected === 'calendar' && r.gmail === undefined && r.calendar?.operation === 'list',
      `status=${r.status} capability=${r.capability?.selected} operation=${r.calendar?.operation}`
    );
  }

  // ---------- B: search event ----------
  {
    const r = await runTask({ sessionId: SID, goal: 'Find my dentist appointment', onEvent: () => {}, taskId: nanoid() });
    check(
      'B. search by keyword — finds the Dentist Appointment event',
      r.status === 'success' && r.calendar?.operation === 'search' && /dentist/i.test(r.result),
      `status=${r.status} result=${r.result.slice(0, 150)}`
    );
  }

  // ---------- C: free/busy ----------
  {
    const r = await runTask({ sessionId: SID, goal: 'Am I free tomorrow at 3 PM?', onEvent: () => {}, taskId: nanoid() });
    check(
      'C. free/busy — correctly reports NOT free (Project Sync fixture occupies 3-3:30pm tomorrow)',
      r.status === 'success' && r.calendar?.operation === 'freebusy' && /not fully free/i.test(r.result),
      `status=${r.status} result=${r.result.slice(0, 150)}`
    );
  }
  {
    const r = await runTask({ sessionId: SID, goal: 'Am I free tomorrow at 8 AM?', onEvent: () => {}, taskId: nanoid() });
    check(
      'C2. free/busy — correctly reports free for an open slot',
      r.status === 'success' && /you're free/i.test(r.result),
      `status=${r.status} result=${r.result.slice(0, 150)}`
    );
  }

  // ---------- J: timezone handling — resolved times stay in the configured local timezone ----------
  {
    const { DEFAULT_TIMEZONE, isoAt } = await import('@/core/capabilities/calendar/datetime');
    const start = isoAt(1, 15, 0); // tomorrow 3:00 PM local
    const local = new Date(start).toLocaleString('en-US', { timeZone: DEFAULT_TIMEZONE, hour: 'numeric', minute: '2-digit', hour12: false });
    check(
      'J. timezone — isoAt(1, 15, 0) resolves to 15:00 in the configured local timezone, not UTC',
      local.startsWith('15:'),
      `timezone=${DEFAULT_TIMEZONE} resolvedLocal=${local}`
    );
  }

  // ---------- routing sanity: "Open Google Calendar" must NOT be intercepted as Calendar capability ----------
  {
    const r = await runTask({ sessionId: SID, goal: 'Open calendar.google.com', onEvent: () => {}, taskId: nanoid() });
    check(
      'ROUTING. "Open calendar.google.com" is browser navigation, not the Calendar capability',
      r.capability?.selected !== 'calendar',
      `capability=${r.capability?.selected}`
    );
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
