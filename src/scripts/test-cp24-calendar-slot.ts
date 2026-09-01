/**
 * Checkpoint 24 §Calendar — pending conversational slot (calendar_datetime).
 *
 * Target experience: "Schedule a meeting with Alice" resolves the attendee
 * and asks for date/time (Calendar's own existing needsClarification
 * message — see calendar/intent.ts's resolveCreateTiming); the user's very
 * next raw turn ("Tomorrow at 2 PM") is interpreted as the missing
 * date/time ONLY because a calendar_datetime slot is active for this
 * session. The second turn only ever produces a PROPOSAL — it is never
 * itself confirmation; the existing, entirely unmodified
 * calendarPendingActionStore confirmation gate still applies.
 */
const TEST_PREFS_PATH = require('os').tmpdir() + '/jarvis-cp24-calendar-slot-' + Date.now() + '.json';
process.env.JARVIS_PREFERENCES_PATH = TEST_PREFS_PATH;

process.env.USE_MOCK_GMAIL = 'true';
process.env.USE_MOCK_CALENDAR = 'true';
process.env.USE_MOCK_TASKS = 'true';
process.env.USE_MOCK_CONTACTS = 'true';

import { runTask } from '@/core/agent/task-manager';
import { pendingActionStore } from '@/core/capabilities/gmail/pending-action';
import { calendarPendingActionStore } from '@/core/capabilities/calendar/pending-action';
import { tasksPendingActionStore } from '@/core/capabilities/tasks/pending-action';
import { pendingSlotStore } from '@/core/agent/pending-slot';
import { getCalendarClient } from '@/core/capabilities/calendar/resolve';
import { preferencesStore } from '@/core/preferences/store';
import { nanoid } from 'nanoid';

const SID = 'test-session-a';
const SID_B = 'test-session-b';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

function clearAllPending(sid: string) {
  pendingActionStore.clear(sid);
  calendarPendingActionStore.clear(sid);
  tasksPendingActionStore.clear(sid);
  pendingSlotStore.clear(sid);
}

async function realEventCount(): Promise<number> {
  const client = getCalendarClient();
  const result = await client.searchEvents('Alice', 20);
  return result.events.length;
}

async function main() {
  clearAllPending(SID);
  clearAllPending(SID_B);
  preferencesStore.forgetAll();

  // ---------- 1. "Schedule a meeting with Alice" -> asks when, no event, slot created ----------
  {
    const before = await realEventCount();
    const r = await runTask({ sessionId: SID, goal: 'Schedule a meeting with Alice', onEvent: () => {}, taskId: nanoid() });
    const after = await realEventCount();
    check(
      '1. "Schedule a meeting with Alice" — asks for date/time, no event created, attendee already resolved',
      r.capability?.selected === 'calendar' && r.outcome === 'blocked' && /date|time/i.test(r.result) && before === after,
      `result=${r.result}`
    );
    check('1b. a calendar_datetime slot is now active, with the attendee already resolved', pendingSlotStore.active(SID)?.kind === 'calendar_datetime' && (pendingSlotStore.active(SID) as any).attendees?.[0] === 'alice@example.com');
  }

  // ---------- 2. "Tomorrow at 2 PM" -> completes the slot into a real proposal (never a created event) ----------
  {
    const before = await realEventCount();
    const r = await runTask({ sessionId: SID, goal: 'Tomorrow at 2 PM', onEvent: () => {}, taskId: nanoid() });
    const after = await realEventCount();
    check(
      '2. "Tomorrow at 2 PM" — completes the pending slot into an EVENT READY FOR CONFIRMATION proposal, attendee carried over, nothing actually scheduled',
      r.capability?.selected === 'calendar' &&
        /EVENT READY FOR CONFIRMATION/.test(r.result) &&
        /alice@example\.com/.test(r.result) &&
        !!r.calendar?.pendingAction &&
        before === after,
      `result=${r.result}`
    );
    check('2b. slot is cleared after completion', !pendingSlotStore.active(SID));
    clearAllPending(SID);
  }

  // ---------- 3. stored default duration fills missing duration ----------
  {
    preferencesStore.set('meetingDurationMinutes', 45);
    await runTask({ sessionId: SID, goal: 'Schedule a meeting with Alice', onEvent: () => {}, taskId: nanoid() });
    const r = await runTask({ sessionId: SID, goal: 'Tomorrow at 2 PM', onEvent: () => {}, taskId: nanoid() });
    check(
      '3. follow-up with no duration mentioned — stored 45-minute default preference fills it in',
      /EVENT READY FOR CONFIRMATION/.test(r.result) && /45 minutes/.test(r.result),
      `result=${r.result}`
    );
    clearAllPending(SID);
    preferencesStore.forgetAll();
  }

  // ---------- 4. explicit duration in follow-up wins over any stored default ----------
  {
    preferencesStore.set('meetingDurationMinutes', 45);
    await runTask({ sessionId: SID, goal: 'Schedule a meeting with Alice', onEvent: () => {}, taskId: nanoid() });
    const r = await runTask({ sessionId: SID, goal: 'Tomorrow at 2 PM for 15 minutes', onEvent: () => {}, taskId: nanoid() });
    check(
      '4. an explicit duration stated IN THE FOLLOW-UP overrides the stored 45-minute default',
      /EVENT READY FOR CONFIRMATION/.test(r.result) && /START: [^\n]*2:00 PM/.test(r.result) && /END: [^\n]*2:15 PM/.test(r.result),
      `result=${r.result}`
    );
    clearAllPending(SID);
    preferencesStore.forgetAll();
  }

  // ---------- 5. the second (completing) turn never itself confirms — it only produces a proposal ----------
  {
    const before = await realEventCount();
    await runTask({ sessionId: SID, goal: 'Schedule a meeting with Alice', onEvent: () => {}, taskId: nanoid() });
    const r = await runTask({ sessionId: SID, goal: 'Tomorrow at 2 PM', onEvent: () => {}, taskId: nanoid() });
    const after = await realEventCount();
    check(
      '5. the completing turn produces ONLY a proposal — outcome is "completed" for the PROPOSAL step, but no real event exists yet and a separate confirmation is still required',
      r.status === 'success' && !!r.calendar?.pendingAction && r.calendar.pendingAction.confirmationRequired === true && before === after,
      `status=${r.status} pendingAction=${JSON.stringify(r.calendar?.pendingAction)}`
    );
    clearAllPending(SID);
  }

  // ---------- 6. "Cancel it" during missing-date clarification clears the slot ----------
  {
    await runTask({ sessionId: SID, goal: 'Schedule a meeting with Alice', onEvent: () => {}, taskId: nanoid() });
    check('6a. setup — slot active', !!pendingSlotStore.active(SID));
    const before = await realEventCount();
    const r = await runTask({ sessionId: SID, goal: 'Cancel it.', onEvent: () => {}, taskId: nanoid() });
    const after = await realEventCount();
    check('6. "Cancel it." during missing-date clarification — no event created, no proposal pending', !/EVENT READY FOR CONFIRMATION/.test(r.result) && !calendarPendingActionStore.active(SID) && before === after, `result=${r.result}`);
    check('6b. slot cleared by the cancellation', !pendingSlotStore.active(SID));
    clearAllPending(SID);
  }

  // ---------- 7. "Start over" clears the slot ----------
  {
    await runTask({ sessionId: SID, goal: 'Schedule a meeting with Alice', onEvent: () => {}, taskId: nanoid() });
    check('7a. setup — slot active', !!pendingSlotStore.active(SID));
    await runTask({ sessionId: SID, goal: 'Start over.', onEvent: () => {}, taskId: nanoid() });
    check('7. "Start over." clears the pending calendar_datetime slot', !pendingSlotStore.active(SID));
    clearAllPending(SID);
  }

  // ---------- 8. TTL expiration — an old slot cannot be completed ----------
  {
    pendingSlotStore.__setForTesting(SID, {
      kind: 'calendar_datetime',
      attendees: ['alice@example.com'],
      title: 'Meeting with Alice',
      createdAt: Date.now() - 11 * 60 * 1000,
    });
    const before = await realEventCount();
    const r = await runTask({ sessionId: SID, goal: 'Tomorrow at 2 PM', onEvent: () => {}, taskId: nanoid() });
    const after = await realEventCount();
    check('8. expired slot (11 min old) — the follow-up is NOT treated as a datetime answer, no proposal, no event', !/EVENT READY FOR CONFIRMATION/.test(r.result) && before === after, `result=${r.result}`);
    check('8b. expired slot reports as inactive', !pendingSlotStore.active(SID));
    clearAllPending(SID);
  }

  // ---------- 9. cross-session isolation ----------
  {
    clearAllPending(SID);
    clearAllPending(SID_B);
    await runTask({ sessionId: SID, goal: 'Schedule a meeting with Alice', onEvent: () => {}, taskId: nanoid() });
    check('9a. setup — Session A has an active slot, Session B does not', !!pendingSlotStore.active(SID) && !pendingSlotStore.active(SID_B));
    const r = await runTask({ sessionId: SID_B, goal: 'Tomorrow at 2 PM', onEvent: () => {}, taskId: nanoid() });
    check('9. Session B\'s identical follow-up does NOT complete Session A\'s pending slot', !/EVENT READY FOR CONFIRMATION/.test(r.result), `result=${r.result}`);
    check('9b. Session A\'s slot is untouched', !!pendingSlotStore.active(SID));
    clearAllPending(SID);
    clearAllPending(SID_B);
  }

  // ---------- 10. an active calendar slot cannot hijack an explicit new Gmail/Tasks command ----------
  {
    clearAllPending(SID);
    await runTask({ sessionId: SID, goal: 'Schedule a meeting with Alice', onEvent: () => {}, taskId: nanoid() });
    check('10a. setup — slot active', !!pendingSlotStore.active(SID));
    const r = await runTask({ sessionId: SID, goal: 'email Alice', onEvent: () => {}, taskId: nanoid() });
    check(
      '10. an explicit, complete Gmail command interrupts an active Calendar slot — Gmail clarification runs, no event/proposal created',
      r.capability?.selected === 'gmail' && !/EVENT READY FOR CONFIRMATION/.test(r.result),
      `capability=${r.capability?.selected} result=${r.result}`
    );
    clearAllPending(SID);
  }

  // ---------- 11. ambiguous/unknown attendee does not create an unsafe slot ----------
  {
    clearAllPending(SID);
    const r1 = await runTask({ sessionId: SID, goal: 'Schedule a meeting with John', onEvent: () => {}, taskId: nanoid() });
    check('11a. "Schedule a meeting with John" (ambiguous — two John Smith contacts) — blocked, asks which one', r1.outcome === 'blocked', `result=${r1.result}`);
    check('11b. no calendar_datetime slot created for an ambiguous attendee', !pendingSlotStore.active(SID));
    clearAllPending(SID);

    const r2 = await runTask({ sessionId: SID, goal: 'Schedule a meeting with Zzznobody', onEvent: () => {}, taskId: nanoid() });
    check('11c. "Schedule a meeting with Zzznobody" (no matching contact) — blocked, does not invent an attendee', r2.outcome === 'blocked', `result=${r2.result}`);
    check('11d. no calendar_datetime slot created for an unresolved attendee', !pendingSlotStore.active(SID));
    clearAllPending(SID);
  }

  // ---------- 12. real Calendar mutation count remains unchanged throughout the whole flow, until explicit confirmation ----------
  {
    clearAllPending(SID);
    const before = await realEventCount();
    await runTask({ sessionId: SID, goal: 'Schedule a meeting with Alice', onEvent: () => {}, taskId: nanoid() });
    await runTask({ sessionId: SID, goal: 'Tomorrow at 2 PM', onEvent: () => {}, taskId: nanoid() });
    const afterProposal = await realEventCount();
    check('12. zero real Calendar mutations from clarification through proposal — only an explicit "Create it." would create anything', before === afterProposal, `before=${before} after=${afterProposal}`);
    clearAllPending(SID);
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
