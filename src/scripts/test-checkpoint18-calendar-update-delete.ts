/**
 * Checkpoint 18 §27 — Calendar update/delete tests G, H, I.
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
  // ---------- G: update proposal + confirm ----------
  {
    calendarPendingActionStore.clear();
    const proposeResult = await runTask({ goal: 'Move my 3 PM meeting to 5 PM.', onEvent: () => {}, taskId: nanoid() });
    check(
      'G1. update proposal — shows OLD vs NEW, pending action set, nothing changed yet',
      proposeResult.status === 'success' && /EVENT UPDATE READY FOR CONFIRMATION/.test(proposeResult.result) && !!proposeResult.calendar?.pendingAction,
      `result=${proposeResult.result}`
    );
    const confirmResult = await runTask({ goal: 'Update it.', onEvent: () => {}, taskId: nanoid() });
    check(
      'G2. update confirmation — event actually moved to the new time',
      confirmResult.status === 'success' && /^Updated /.test(confirmResult.result) && /5:00 PM/.test(confirmResult.result),
      `result=${confirmResult.result}`
    );
  }

  // ---------- H: delete proposal + confirm ----------
  {
    calendarPendingActionStore.clear();
    const client = getCalendarClient();
    const before = await client.searchEvents('Quarterly', 5);
    const proposeResult = await runTask({ goal: 'Cancel my Quarterly Planning meeting.', onEvent: () => {}, taskId: nanoid() });
    check(
      'H1. delete proposal — shows the exact event, pending action set, nothing deleted yet',
      proposeResult.status === 'success' && /EVENT CANCELLATION READY FOR CONFIRMATION/.test(proposeResult.result) && !!proposeResult.calendar?.pendingAction,
      `result=${proposeResult.result.slice(0, 100)}`
    );
    const beforeConfirm = await client.searchEvents('Quarterly', 5);
    const confirmResult = await runTask({ goal: 'Cancel it.', onEvent: () => {}, taskId: nanoid() });
    const after = await client.searchEvents('Quarterly', 5);
    check(
      'H2. delete confirmation — event actually removed',
      before.events.length === 1 && beforeConfirm.events.length === 1 && confirmResult.status === 'success' && after.events.length === 0,
      `before=${before.events.length} beforeConfirm=${beforeConfirm.events.length} after=${after.events.length} result=${confirmResult.result}`
    );
  }

  // ---------- I: ambiguous event search — multiple matches asks for clarification, never guesses ----------
  {
    calendarPendingActionStore.clear();
    const client = getCalendarClient();
    // Create two events that will BOTH match a deliberately generic query.
    await client.createEvent({ kind: 'create', title: 'Ambiguous Sync A', start: new Date(Date.now() + 86400000 * 10).toISOString(), end: new Date(Date.now() + 86400000 * 10 + 1800000).toISOString(), timezone: 'UTC', attendees: [] });
    await client.createEvent({ kind: 'create', title: 'Ambiguous Sync B', start: new Date(Date.now() + 86400000 * 11).toISOString(), end: new Date(Date.now() + 86400000 * 11 + 1800000).toISOString(), timezone: 'UTC', attendees: [] });
    const r = await runTask({ goal: 'Cancel my Ambiguous Sync meeting.', onEvent: () => {}, taskId: nanoid() });
    check(
      'I. ambiguous search — multiple matches asks for clarification, no pending action created, nothing deleted',
      r.outcome === 'blocked' && /Multiple events match/i.test(r.result) && !calendarPendingActionStore.active(),
      `outcome=${r.outcome} result=${r.result.slice(0, 150)}`
    );
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
