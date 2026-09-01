/**
 * Checkpoint 25 §Calendar — conversational proposal revision (Priority 1).
 * Extends the existing Checkpoint 22 proposal-revision.ts mechanism (never
 * a second, competing architecture) with time/date/duration/combined
 * revision, preserving every untouched field, never confirming, and never
 * letting a stored preference overwrite an explicitly revised duration.
 */
const TEST_PREFS_PATH = require('os').tmpdir() + '/jarvis-cp25-calendar-revision-' + Date.now() + '.json';
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
}

async function eventCount(): Promise<number> {
  const client = getCalendarClient();
  const result = await client.searchEvents('Alice', 20);
  return result.events.length;
}

async function main() {
  clearAllPending(SID);
  clearAllPending(SID_B);
  preferencesStore.forgetAll();

  // ---------- 1. time revision ----------
  {
    clearAllPending(SID);
    await runTask({ sessionId: SID, goal: 'Schedule a meeting with Alice tomorrow at 2 PM', onEvent: () => {}, taskId: nanoid() });
    const before = calendarPendingActionStore.active(SID)!.proposal;
    check('1-setup. original proposal at 2 PM with Alice', /alice@example\.com/.test(before.attendees.join()) && new Date(before.start).getHours() === 14);
    const r = await runTask({ sessionId: SID, goal: 'Make it 3 PM instead.', onEvent: () => {}, taskId: nanoid() });
    const after = calendarPendingActionStore.active(SID)!.proposal;
    check(
      '1. time revision — "Make it 3 PM instead." moves start to 3 PM',
      /UPDATED EVENT READY FOR CONFIRMATION/.test(r.result) && new Date(after.start).getHours() === 15,
      `result=${r.result}`
    );
    check('1b. same calendar day preserved (only time changed)', new Date(after.start).toDateString() === new Date(before.start).toDateString());
    clearAllPending(SID);
  }

  // ---------- 2. date revision ----------
  {
    clearAllPending(SID);
    await runTask({ sessionId: SID, goal: 'Schedule a meeting with Alice tomorrow at 2 PM', onEvent: () => {}, taskId: nanoid() });
    const before = calendarPendingActionStore.active(SID)!.proposal;
    const r = await runTask({ sessionId: SID, goal: 'Move it to Friday.', onEvent: () => {}, taskId: nanoid() });
    const after = calendarPendingActionStore.active(SID)!.proposal;
    check('2. date revision — "Move it to Friday." changes the date', /UPDATED EVENT READY FOR CONFIRMATION/.test(r.result) && new Date(after.start).getDay() === 5, `result=${r.result}`);
    check('2b. time-of-day preserved (still 2 PM)', new Date(after.start).getHours() === new Date(before.start).getHours());
    clearAllPending(SID);
  }

  // ---------- 3. duration revision ----------
  {
    clearAllPending(SID);
    await runTask({ sessionId: SID, goal: 'Schedule a meeting with Alice tomorrow at 2 PM', onEvent: () => {}, taskId: nanoid() });
    const before = calendarPendingActionStore.active(SID)!.proposal;
    const beforeMinutes = (new Date(before.end).getTime() - new Date(before.start).getTime()) / 60000;
    const r = await runTask({ sessionId: SID, goal: 'Make it 45 minutes.', onEvent: () => {}, taskId: nanoid() });
    const after = calendarPendingActionStore.active(SID)!.proposal;
    const afterMinutes = (new Date(after.end).getTime() - new Date(after.start).getTime()) / 60000;
    check('3. duration revision — "Make it 45 minutes." changes duration to 45', /UPDATED EVENT READY FOR CONFIRMATION/.test(r.result) && afterMinutes === 45, `before=${beforeMinutes} after=${afterMinutes} result=${r.result}`);
    check('3b. start time unchanged by a duration-only revision', new Date(after.start).getTime() === new Date(before.start).getTime());
    clearAllPending(SID);
  }

  // ---------- 4. combined date/time/duration revision ----------
  {
    clearAllPending(SID);
    await runTask({ sessionId: SID, goal: 'Schedule a meeting with Alice tomorrow at 2 PM', onEvent: () => {}, taskId: nanoid() });
    const r = await runTask({ sessionId: SID, goal: 'Move it to Friday at 4 PM for 45 minutes.', onEvent: () => {}, taskId: nanoid() });
    const after = calendarPendingActionStore.active(SID)!.proposal;
    const afterMinutes = (new Date(after.end).getTime() - new Date(after.start).getTime()) / 60000;
    check(
      '4. combined revision — date, time, AND duration all change in one turn',
      /UPDATED EVENT READY FOR CONFIRMATION/.test(r.result) && new Date(after.start).getDay() === 5 && new Date(after.start).getHours() === 16 && afterMinutes === 45,
      `day=${new Date(after.start).getDay()} hour=${new Date(after.start).getHours()} minutes=${afterMinutes} result=${r.result}`
    );
    clearAllPending(SID);
  }

  // ---------- 5. untouched fields preserved (title) ----------
  {
    clearAllPending(SID);
    await runTask({ sessionId: SID, goal: 'Schedule a meeting with Alice tomorrow at 2 PM', onEvent: () => {}, taskId: nanoid() });
    const beforeTitle = calendarPendingActionStore.active(SID)!.proposal.title;
    await runTask({ sessionId: SID, goal: 'Make it 3 PM instead.', onEvent: () => {}, taskId: nanoid() });
    const afterTitle = calendarPendingActionStore.active(SID)!.proposal.title;
    check('5. untouched title preserved across revision', beforeTitle === afterTitle && afterTitle.length > 0, `before=${beforeTitle} after=${afterTitle}`);
    clearAllPending(SID);
  }

  // ---------- 6. attendee preserved ----------
  {
    clearAllPending(SID);
    await runTask({ sessionId: SID, goal: 'Schedule a meeting with Alice tomorrow at 2 PM', onEvent: () => {}, taskId: nanoid() });
    await runTask({ sessionId: SID, goal: 'Make it 3 PM instead.', onEvent: () => {}, taskId: nanoid() });
    const after = calendarPendingActionStore.active(SID)!.proposal;
    check('6. attendee preserved across revision (Contacts never re-resolved)', after.attendees.includes('alice@example.com'));
    clearAllPending(SID);
  }

  // ---------- 7. stored default does not overwrite explicit revised duration ----------
  {
    clearAllPending(SID);
    preferencesStore.set('meetingDurationMinutes', 60);
    await runTask({ sessionId: SID, goal: 'Schedule a meeting with Alice tomorrow at 2 PM', onEvent: () => {}, taskId: nanoid() });
    const original = calendarPendingActionStore.active(SID)!.proposal;
    const originalMinutes = (new Date(original.end).getTime() - new Date(original.start).getTime()) / 60000;
    check('7-setup. original proposal used the stored 60-minute default', originalMinutes === 60);

    // A revision that does NOT mention duration must preserve the
    // proposal's existing duration — never re-query the preference.
    await runTask({ sessionId: SID, goal: 'Make it 3 PM instead.', onEvent: () => {}, taskId: nanoid() });
    const afterTimeOnly = calendarPendingActionStore.active(SID)!.proposal;
    const afterTimeOnlyMinutes = (new Date(afterTimeOnly.end).getTime() - new Date(afterTimeOnly.start).getTime()) / 60000;
    check('7a. time-only revision preserves the existing 60-minute duration (not re-derived from preference)', afterTimeOnlyMinutes === 60, `minutes=${afterTimeOnlyMinutes}`);

    // An explicit duration THIS turn always wins over the stored default.
    const r = await runTask({ sessionId: SID, goal: 'Make it 20 minutes.', onEvent: () => {}, taskId: nanoid() });
    const afterExplicit = calendarPendingActionStore.active(SID)!.proposal;
    const afterExplicitMinutes = (new Date(afterExplicit.end).getTime() - new Date(afterExplicit.start).getTime()) / 60000;
    check('7b. explicit revised duration (20 minutes) overrides the stored 60-minute default', afterExplicitMinutes === 20, `minutes=${afterExplicitMinutes} result=${r.result}`);

    preferencesStore.forgetAll();
    clearAllPending(SID);
  }

  // ---------- 8. repeated revision still one proposal ----------
  {
    clearAllPending(SID);
    await runTask({ sessionId: SID, goal: 'Schedule a meeting with Alice tomorrow at 2 PM', onEvent: () => {}, taskId: nanoid() });
    await runTask({ sessionId: SID, goal: 'Make it 3 PM instead.', onEvent: () => {}, taskId: nanoid() });
    await runTask({ sessionId: SID, goal: 'Make it 4 PM instead.', onEvent: () => {}, taskId: nanoid() });
    const final = calendarPendingActionStore.active(SID)!.proposal;
    check('8. repeated revision — exactly one active proposal, reflecting the FINAL revision (4 PM)', new Date(final.start).getHours() === 16 && calendarPendingActionStore.sessionCount === 1, `hour=${new Date(final.start).getHours()} sessionCount=${calendarPendingActionStore.sessionCount}`);
    clearAllPending(SID);
  }

  // ---------- 9. revision never confirms ----------
  {
    clearAllPending(SID);
    const before = await eventCount();
    await runTask({ sessionId: SID, goal: 'Schedule a meeting with Alice tomorrow at 2 PM', onEvent: () => {}, taskId: nanoid() });
    const r = await runTask({ sessionId: SID, goal: 'Make it 3 PM instead.', onEvent: () => {}, taskId: nanoid() });
    const after = await eventCount();
    check(
      '9. revision never confirms — proposal still pending, zero real events created, "Create it." still required',
      before === after && !!calendarPendingActionStore.active(SID) && r.outcome !== 'blocked',
      `before=${before} after=${after} result=${r.result}`
    );
    clearAllPending(SID);
  }

  // ---------- 10. final confirmation executes the final revision exactly once ----------
  {
    clearAllPending(SID);
    const before = await eventCount();
    await runTask({ sessionId: SID, goal: 'Schedule a meeting with Alice tomorrow at 2 PM', onEvent: () => {}, taskId: nanoid() });
    await runTask({ sessionId: SID, goal: 'Make it 3 PM instead.', onEvent: () => {}, taskId: nanoid() });
    await runTask({ sessionId: SID, goal: 'Make it 45 minutes.', onEvent: () => {}, taskId: nanoid() });
    const r = await runTask({ sessionId: SID, goal: 'Create it.', onEvent: () => {}, taskId: nanoid() });
    const after = await eventCount();
    check(
      '10. "Create it." creates EXACTLY ONE real event, reflecting the final revision (3 PM, 45 minutes)',
      after === before + 1 && /^Created /.test(r.result) && /3:00 PM/.test(r.result),
      `before=${before} after=${after} result=${r.result}`
    );
    // Repeated confirmation must retain existing duplicate-protection semantics.
    const second = await runTask({ sessionId: SID, goal: 'Create it.', onEvent: () => {}, taskId: nanoid() });
    const afterSecond = await eventCount();
    check('10b. repeated confirmation does not create a second event (existing duplicate-protection preserved)', afterSecond === after, `result=${second.result}`);
    clearAllPending(SID);
  }

  // ---------- 11. cancellation cancels the revised proposal ----------
  {
    clearAllPending(SID);
    const before = await eventCount();
    await runTask({ sessionId: SID, goal: 'Schedule a meeting with Alice tomorrow at 2 PM', onEvent: () => {}, taskId: nanoid() });
    await runTask({ sessionId: SID, goal: 'Make it 3 PM instead.', onEvent: () => {}, taskId: nanoid() });
    const r = await runTask({ sessionId: SID, goal: 'Cancel it.', onEvent: () => {}, taskId: nanoid() });
    const after = await eventCount();
    check('11. "Cancel it." cancels the REVISED proposal — no event created', /calendar change was not made/i.test(r.result) && !calendarPendingActionStore.active(SID) && before === after, `result=${r.result}`);
    clearAllPending(SID);
  }

  // ---------- 12. cross-session revision blocked ----------
  {
    clearAllPending(SID);
    clearAllPending(SID_B);
    await runTask({ sessionId: SID, goal: 'Schedule a meeting with Alice tomorrow at 2 PM', onEvent: () => {}, taskId: nanoid() });
    const before = calendarPendingActionStore.active(SID)!.proposal;
    const r = await runTask({ sessionId: SID_B, goal: 'Make it 3 PM instead.', onEvent: () => {}, taskId: nanoid() });
    const after = calendarPendingActionStore.active(SID)!.proposal;
    check('12. Session B\'s revision attempt does not touch Session A\'s pending proposal', new Date(after.start).getTime() === new Date(before.start).getTime(), `result=${r.result}`);
    check('12b. Session B has nothing pending of its own', !calendarPendingActionStore.active(SID_B));
    clearAllPending(SID);
    clearAllPending(SID_B);
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
