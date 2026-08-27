/**
 * Checkpoint 19 §18 — Calendar + Contacts integration tests A-E.
 */
process.env.USE_MOCK_CALENDAR = 'true';
process.env.USE_MOCK_CONTACTS = 'true';

import { runTask } from '@/core/agent/task-manager';
import { calendarPendingActionStore } from '@/core/capabilities/calendar/pending-action';
import { getCalendarClient } from '@/core/capabilities/calendar/resolve';
import { nanoid } from 'nanoid';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

async function main() {
  // ---------- A: "Schedule a meeting with Alice tomorrow at 3" -> resolve, proposal, confirmation required ----------
  {
    calendarPendingActionStore.clear();
    const client = getCalendarClient();
    const before = await client.listEvents(new Date().toISOString(), new Date(Date.now() + 30 * 86400000).toISOString(), 'UTC', 100);
    const r = await runTask({ goal: 'Schedule a meeting with Alice tomorrow at 4 PM for 30 minutes.', onEvent: () => {}, taskId: nanoid() });
    const after = await client.listEvents(new Date().toISOString(), new Date(Date.now() + 30 * 86400000).toISOString(), 'UTC', 100);
    check(
      'A. name resolves via Contacts, attendee shown in proposal, NO event created yet',
      r.status === 'success' &&
        /EVENT READY FOR CONFIRMATION/.test(r.result) &&
        /alice@example\.com/.test(r.result) &&
        r.resolution?.status === 'resolved' &&
        after.length === before.length,
      `result=${r.result.slice(0, 200)} resolution=${JSON.stringify(r.resolution)} before=${before.length} after=${after.length}`
    );
  }

  // ---------- B: ambiguous "John Smith" -> clarification, no proposal/create ----------
  {
    calendarPendingActionStore.clear();
    const r = await runTask({ goal: 'Schedule a meeting with John Smith tomorrow at 5 PM for 30 minutes.', onEvent: () => {}, taskId: nanoid() });
    check(
      'B. ambiguous contact -> clarification, no pending action, no proposal built',
      r.outcome === 'blocked' && /Which one/i.test(r.result) && !calendarPendingActionStore.active(),
      `outcome=${r.outcome} result=${r.result.slice(0, 200)}`
    );
  }

  // ---------- C: missing contact -> clarification ----------
  {
    calendarPendingActionStore.clear();
    const r = await runTask({ goal: 'Schedule a meeting with Zorblax tomorrow at 6 PM for 30 minutes.', onEvent: () => {}, taskId: nanoid() });
    check(
      'C. unknown name -> clarification, no proposal built',
      r.outcome === 'blocked' && /couldn't find/i.test(r.result) && !calendarPendingActionStore.active(),
      `outcome=${r.outcome} result=${r.result.slice(0, 200)}`
    );
  }

  // ---------- D: explicit email still works exactly as before ----------
  {
    calendarPendingActionStore.clear();
    const r = await runTask({ goal: 'Schedule a meeting with explicit@example.com tomorrow at 7 PM for 30 minutes.', onEvent: () => {}, taskId: nanoid() });
    check(
      'D. explicit email bypasses Contacts entirely, works exactly as Checkpoint 18',
      r.status === 'success' && /EVENT READY FOR CONFIRMATION/.test(r.result) && /explicit@example\.com/.test(r.result) && r.resolution === undefined,
      `result=${r.result.slice(0, 200)} resolution=${JSON.stringify(r.resolution)}`
    );
  }

  // ---------- E: double-confirmation protection unchanged for a Contacts-resolved proposal ----------
  {
    calendarPendingActionStore.clear();
    await runTask({ goal: 'Schedule a meeting with Alice tomorrow at 8 PM for 30 minutes.', onEvent: () => {}, taskId: nanoid() });
    const first = await runTask({ goal: 'Create it.', onEvent: () => {}, taskId: nanoid() });
    const second = await runTask({ goal: 'Create it.', onEvent: () => {}, taskId: nanoid() });
    check(
      'E. create-confirmation/idempotency behavior is unchanged for a Contacts-resolved proposal',
      first.status === 'success' && /^Created /.test(first.result) && /no pending/i.test(second.result),
      `first=${first.result} second=${second.result}`
    );
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
