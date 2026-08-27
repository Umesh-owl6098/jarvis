/**
 * Checkpoint 19 §12 D/H — the two Calendar+Contacts cases not already
 * covered by test-checkpoint19-calendar-contacts.ts: a contact with
 * multiple non-primary emails (must ask, never guess) and cancellation
 * mid-lookup (no proposal, no pending action).
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
  // ---------- D: contact with two emails, neither marked primary -> clarification, no proposal/create ----------
  {
    calendarPendingActionStore.clear();
    const client = getCalendarClient();
    const before = await client.listEvents(new Date().toISOString(), new Date(Date.now() + 30 * 86400000).toISOString(), 'UTC', 100);
    const r = await runTask({ goal: 'Schedule a meeting with Sam tomorrow at 2 PM for 30 minutes.', onEvent: () => {}, taskId: nanoid() });
    const after = await client.listEvents(new Date().toISOString(), new Date(Date.now() + 30 * 86400000).toISOString(), 'UTC', 100);
    check(
      'D. multi-email contact with no primary -> clarification, no proposal built, NO event created',
      r.outcome === 'blocked' &&
        /use .*sam\.work@example\.com.* or .*sam\.personal@example\.com/i.test(r.result) &&
        !calendarPendingActionStore.active() &&
        after.length === before.length,
      `outcome=${r.outcome} result=${r.result.slice(0, 250)} before=${before.length} after=${after.length}`
    );
  }

  // ---------- H: cancellation mid-lookup -> stopped, no proposal, no pending action ----------
  {
    calendarPendingActionStore.clear();
    const controller = new AbortController();
    controller.abort();
    const r = await runTask({ goal: 'Schedule a meeting with Alice tomorrow at 3 PM for 30 minutes.', onEvent: () => {}, signal: controller.signal, taskId: nanoid() });
    check(
      'H. cancelled before Contacts lookup resolves -> stopped, no proposal, no pending action',
      r.status === 'stopped' && !calendarPendingActionStore.active(),
      `status=${r.status} result=${r.result.slice(0, 200)} pendingActive=${!!calendarPendingActionStore.active()}`
    );
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
