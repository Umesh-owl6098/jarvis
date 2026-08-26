/**
 * Checkpoint 18 §27 — Calendar propose/create tests D, E, F, K.
 */
process.env.USE_MOCK_CALENDAR = 'true';

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
  // ---------- D: proposal only — no event created yet ----------
  {
    calendarPendingActionStore.clear();
    const client = getCalendarClient();
    const before = await client.listEvents(new Date().toISOString(), new Date(Date.now() + 30 * 86400000).toISOString(), 'UTC', 100);
    const r = await runTask({ goal: 'Jarvis, schedule a meeting tomorrow at 10 AM for 30 minutes.', onEvent: () => {}, taskId: nanoid() });
    const after = await client.listEvents(new Date().toISOString(), new Date(Date.now() + 30 * 86400000).toISOString(), 'UTC', 100);
    check(
      'D. proposal only — EVENT READY FOR CONFIRMATION shown, pending action set, NO event actually created',
      r.status === 'success' &&
        /EVENT READY FOR CONFIRMATION/.test(r.result) &&
        !!r.calendar?.pendingAction &&
        after.length === before.length,
      `status=${r.status} pendingSet=${!!r.calendar?.pendingAction} eventsBefore=${before.length} eventsAfter=${after.length}`
    );
  }

  // ---------- E: create confirmation — event actually created ----------
  {
    calendarPendingActionStore.clear();
    await runTask({ goal: 'Jarvis, schedule a meeting tomorrow at 11 AM for 30 minutes.', onEvent: () => {}, taskId: nanoid() });
    const client = getCalendarClient();
    const before = await client.listEvents(new Date().toISOString(), new Date(Date.now() + 30 * 86400000).toISOString(), 'UTC', 100);
    const r = await runTask({ goal: 'Create it.', onEvent: () => {}, taskId: nanoid() });
    const after = await client.listEvents(new Date().toISOString(), new Date(Date.now() + 30 * 86400000).toISOString(), 'UTC', 100);
    check(
      'E. explicit confirmation — event actually created, count increased by exactly 1',
      r.status === 'success' && /^Created /.test(r.result) && after.length === before.length + 1,
      `status=${r.status} before=${before.length} after=${after.length} result=${r.result}`
    );
  }

  // ---------- F: duplicate create blocked ----------
  {
    calendarPendingActionStore.clear();
    await runTask({ goal: 'Jarvis, schedule a meeting tomorrow at 1 PM for 30 minutes.', onEvent: () => {}, taskId: nanoid() });
    const client = getCalendarClient();
    const before = await client.listEvents(new Date().toISOString(), new Date(Date.now() + 30 * 86400000).toISOString(), 'UTC', 100);
    const first = await runTask({ goal: 'Create it.', onEvent: () => {}, taskId: nanoid() });
    const second = await runTask({ goal: 'Create it.', onEvent: () => {}, taskId: nanoid() });
    const after = await client.listEvents(new Date().toISOString(), new Date(Date.now() + 30 * 86400000).toISOString(), 'UTC', 100);
    check(
      'F. duplicate confirmation — second "Create it." reports no pending action, exactly ONE event created',
      first.status === 'success' && /no pending/i.test(second.result) && after.length === before.length + 1,
      `first=${first.result.slice(0, 60)} second=${second.result} before=${before.length} after=${after.length}`
    );
  }

  // ---------- K: conflict detection ----------
  {
    calendarPendingActionStore.clear();
    // Fixture e3 "Project Sync" occupies tomorrow 3:00-3:30 PM — proposing
    // the exact same slot must surface the conflict, not silently ignore it.
    const r = await runTask({ goal: 'Jarvis, schedule a meeting tomorrow at 3 PM for 30 minutes.', onEvent: () => {}, taskId: nanoid() });
    check(
      'K. conflict detection — proposing an overlapping slot surfaces the conflict in the proposal text',
      r.status === 'success' && /CONFLICT/.test(r.result) && /Project Sync/.test(r.result),
      `result=${r.result}`
    );
    calendarPendingActionStore.clear(); // never confirm a deliberately-conflicting test proposal
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
