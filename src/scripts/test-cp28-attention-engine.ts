/**
 * Checkpoint 28 §Engine — the shared deterministic classifier
 * (attention/engine.ts's rankAttentionSignals). Every test here uses an
 * INJECTED, fixed `now` (never the real wall clock) so the 60-minute
 * "starting soon" boundary and the 4-hour "soon" query window are never
 * flaky.
 */
const TEST_PREFS_PATH = require('os').tmpdir() + '/jarvis-cp28-engine-' + Date.now() + '.json';
process.env.JARVIS_PREFERENCES_PATH = TEST_PREFS_PATH;

process.env.USE_MOCK_GMAIL = 'true';
process.env.USE_MOCK_CALENDAR = 'true';
process.env.USE_MOCK_TASKS = 'true';
process.env.USE_MOCK_CONTACTS = 'true';

import { rankAttentionSignals, MEETING_SOON_MINUTES, SOON_WINDOW_MINUTES } from '@/core/agent/attention/engine';
import { __rankSignalsForTesting } from '@/core/agent/attention/runner';
import type { AttentionScope } from '@/core/agent/attention/types';
import { getCalendarClient } from '@/core/capabilities/calendar/resolve';
import { getTasksClient } from '@/core/capabilities/tasks/resolve';
import { dayRangeIso } from '@/core/capabilities/calendar/datetime';
import type { BriefingCalendarEventView, BriefingTaskView, BriefingMailView } from '@/core/agent/briefing/types';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

function ev(id: string, title: string, startIso: string, endIso: string): BriefingCalendarEventView {
  return { id, title, start: startIso, end: endIso, timezone: 'UTC', attendees: [] };
}
function task(id: string, title: string, due?: string): BriefingTaskView {
  return { id, taskListId: 'tl1', title, due };
}
function mail(id: string, subject: string, from: string, date: string): BriefingMailView {
  return { id, subject, from, date, unread: true };
}

async function main() {
  const now = new Date('2026-09-03T12:00:00.000Z');

  // ---------- 1. overdue Task ----------
  {
    const signals = rankAttentionSignals({ calendarEvents: [], tasksOverdue: [task('t1', 'Overdue A', '2026-09-01T00:00:00.000Z')], tasksDueInScope: [], gmailUnread: [] }, now);
    check('1. overdue task produces a Tier-1 task_overdue signal', signals.length === 1 && signals[0].tier === 1 && signals[0].reason === 'task_overdue' && signals[0].source === 'tasks');
  }

  // ---------- 2. due Task ----------
  {
    const signals = rankAttentionSignals({ calendarEvents: [], tasksOverdue: [], tasksDueInScope: [task('t2', 'Due today', '2026-09-03T00:00:00.000Z')], gmailUnread: [] }, now);
    check('2. task due in scope produces a Tier-2 task_due signal', signals.length === 1 && signals[0].tier === 2 && signals[0].reason === 'task_due');
  }

  // ---------- 3. meeting <= 60 min ----------
  {
    const start = new Date(now.getTime() + 30 * 60000).toISOString();
    const signals = rankAttentionSignals({ calendarEvents: [ev('e1', 'Soon meeting', start, start)], tasksOverdue: [], tasksDueInScope: [], gmailUnread: [] }, now);
    check('3. meeting 30 minutes out is Tier-1 meeting_soon', signals.length === 1 && signals[0].tier === 1 && signals[0].reason === 'meeting_soon');
  }

  // ---------- 4. meeting exactly at the 60-minute boundary (inclusive) ----------
  {
    const start = new Date(now.getTime() + MEETING_SOON_MINUTES * 60000).toISOString();
    const signals = rankAttentionSignals({ calendarEvents: [ev('e2', 'Boundary meeting', start, start)], tasksOverdue: [], tasksDueInScope: [], gmailUnread: [] }, now);
    check('4. a meeting starting EXACTLY 60 minutes out is Tier-1 (inclusive boundary)', signals.length === 1 && signals[0].tier === 1 && signals[0].reason === 'meeting_soon', `signals=${JSON.stringify(signals)}`);
  }

  // ---------- 5. meeting just outside the boundary (61 min) ----------
  {
    const start = new Date(now.getTime() + 61 * 60000).toISOString();
    const signals = rankAttentionSignals({ calendarEvents: [ev('e3', 'Just outside', start, start)], tasksOverdue: [], tasksDueInScope: [], gmailUnread: [] }, now);
    check('5. a meeting starting 61 minutes out is Tier-3, NOT Tier-1', signals.length === 1 && signals[0].tier === 3 && signals[0].reason === 'meeting_upcoming', `signals=${JSON.stringify(signals)}`);
  }

  // ---------- 6. meeting well outside the boundary (later, still same "scope") ----------
  {
    const start = new Date(now.getTime() + 5 * 3600000).toISOString();
    const signals = rankAttentionSignals({ calendarEvents: [ev('e4', 'Later', start, start)], tasksOverdue: [], tasksDueInScope: [], gmailUnread: [] }, now);
    check('6. a later meeting (5h out) is Tier-3 meeting_upcoming', signals.length === 1 && signals[0].tier === 3);
  }

  // ---------- 7. unread Gmail ----------
  {
    const signals = rankAttentionSignals({ calendarEvents: [], tasksOverdue: [], tasksDueInScope: [], gmailUnread: [mail('m1', 'Subject A', 'a@example.com', '2026-09-03T10:00:00.000Z')] }, now);
    check('7. unread Gmail produces a Tier-2 unread_mail signal', signals.length === 1 && signals[0].tier === 2 && signals[0].reason === 'unread_mail' && signals[0].source === 'gmail');
  }

  // ---------- 8. read Gmail ignored ----------
  // (rankAttentionSignals only ever receives the caller's ALREADY-filtered
  // "unread" array — there is no read-mail input at all, so a read message
  // structurally cannot produce a signal. Proven at the runner/fetch level
  // in the privacy test file; this proves the engine's OWN contract: an
  // empty gmailUnread array never manufactures anything.)
  {
    const signals = rankAttentionSignals({ calendarEvents: [], tasksOverdue: [], tasksDueInScope: [], gmailUnread: [] }, now);
    check('8. no unread Gmail input produces zero Gmail signals — nothing manufactured', signals.length === 0);
  }

  // ---------- 9. deterministic ordering (tier1 before tier2 before tier3) ----------
  {
    const start3h = new Date(now.getTime() + 3 * 3600000).toISOString();
    const startSoon = new Date(now.getTime() + 10 * 60000).toISOString();
    const signals = rankAttentionSignals(
      {
        calendarEvents: [ev('later', 'Later', start3h, start3h), ev('soon', 'Soon', startSoon, startSoon)],
        tasksOverdue: [task('overdue', 'Overdue')],
        tasksDueInScope: [task('due', 'Due', now.toISOString())],
        gmailUnread: [mail('unread', 'Subj', 'x@example.com', now.toISOString())],
      },
      now
    );
    const tiers = signals.map((s) => s.tier);
    check('9. signals are strictly ordered by tier (1s, then 2s, then 3s)', JSON.stringify(tiers) === JSON.stringify([1, 1, 2, 2, 3]), `tiers=${JSON.stringify(tiers)} reasons=${JSON.stringify(signals.map((s) => s.reason))}`);
  }

  // ---------- 10. tie-breaking — overdue tasks, alphabetical on equal due date ----------
  {
    const signals = rankAttentionSignals(
      { calendarEvents: [], tasksOverdue: [task('z', 'Zebra', '2026-09-01T00:00:00.000Z'), task('a', 'Alpha', '2026-09-01T00:00:00.000Z')], tasksDueInScope: [], gmailUnread: [] },
      now
    );
    check('10. overdue tasks with the same due date tie-break alphabetically', signals[0].label === 'Alpha' && signals[1].label === 'Zebra', `order=${signals.map((s) => s.label)}`);
  }

  // ---------- 11. tie-breaking — overdue tasks, earliest-due-first when dates differ ----------
  {
    const signals = rankAttentionSignals(
      { calendarEvents: [], tasksOverdue: [task('z', 'Zebra', '2026-08-20T00:00:00.000Z'), task('a', 'Alpha', '2026-08-25T00:00:00.000Z')], tasksDueInScope: [], gmailUnread: [] },
      now
    );
    check('11. overdue tasks order by due date (most overdue/earliest first), not alphabetically, when dates differ', signals[0].label === 'Zebra' && signals[1].label === 'Alpha', `order=${signals.map((s) => s.label)}`);
  }

  // ---------- 12. tie-breaking — unread mail, most recent first ----------
  {
    const signals = rankAttentionSignals(
      { calendarEvents: [], tasksOverdue: [], tasksDueInScope: [], gmailUnread: [mail('old', 'Old', 'a@example.com', '2026-09-01T00:00:00.000Z'), mail('new', 'New', 'b@example.com', '2026-09-03T00:00:00.000Z')] },
      now
    );
    check('12. unread mail orders most-recent-first', signals[0].id === 'new' && signals[1].id === 'old', `order=${signals.map((s) => s.id)}`);
  }

  // ---------- 13. tie-breaking — meetings, start-time ascending within a tier ----------
  {
    const later1 = new Date(now.getTime() + 5 * 3600000).toISOString();
    const later2 = new Date(now.getTime() + 3 * 3600000).toISOString();
    const signals = rankAttentionSignals({ calendarEvents: [ev('later1', 'Later1', later1, later1), ev('later2', 'Later2', later2, later2)], tasksOverdue: [], tasksDueInScope: [], gmailUnread: [] }, now);
    check('13. Tier-3 meetings order by start time ascending', signals[0].id === 'later2' && signals[1].id === 'later1', `order=${signals.map((s) => s.id)}`);
  }

  // ---------- 14. injected/fixed `now` — identical input, identical output across repeated calls ----------
  {
    const input = { calendarEvents: [ev('e', 'E', new Date(now.getTime() + 20 * 60000).toISOString(), '')], tasksOverdue: [task('t', 'T', '2026-08-01T00:00:00.000Z')], tasksDueInScope: [], gmailUnread: [] };
    const s1 = rankAttentionSignals(input, now);
    const s2 = rankAttentionSignals(input, now);
    check('14. identical input + injected now produces byte-identical output across repeated calls', JSON.stringify(s1) === JSON.stringify(s2));
  }

  // ---------- 15. "right now" window (60 min) via the full fetch+rank pipeline ----------
  {
    const day = 70;
    const calClient = getCalendarClient();
    const start = new Date(now.getTime() + 45 * 60000);
    await calClient.createEvent({ kind: 'create', title: 'CP28 RightNow Test', start: start.toISOString(), end: new Date(start.getTime() + 1800000).toISOString(), timezone: 'UTC', attendees: [] });
    const scope: AttentionScope = { kind: 'right_now', label: 'right now', rangeStart: now.toISOString(), rangeEnd: new Date(now.getTime() + MEETING_SOON_MINUTES * 60000).toISOString(), tasksDayOffset: 0 };
    const signals = await __rankSignalsForTesting(scope, now);
    const found = signals.find((s) => s.label === 'CP28 RightNow Test');
    check('15. a meeting 45 minutes out is included and Tier-1 within a "right now" (60-min) scope', !!found && found.tier === 1, `found=${JSON.stringify(found)}`);
  }

  // ---------- 16. "soon" window (4h) includes a meeting beyond 60 min but within 4h, as Tier-3 ----------
  {
    const calClient = getCalendarClient();
    const start = new Date(now.getTime() + 3 * 3600000);
    await calClient.createEvent({ kind: 'create', title: 'CP28 Soon Window Test', start: start.toISOString(), end: new Date(start.getTime() + 1800000).toISOString(), timezone: 'UTC', attendees: [] });
    const scope: AttentionScope = { kind: 'soon', label: 'soon', rangeStart: now.toISOString(), rangeEnd: new Date(now.getTime() + SOON_WINDOW_MINUTES * 60000).toISOString(), tasksDayOffset: 0 };
    const signals = await __rankSignalsForTesting(scope, now);
    const found = signals.find((s) => s.label === 'CP28 Soon Window Test');
    check('16. a meeting 3 hours out is included as Tier-3 within a "soon" (4h) scope', !!found && found.tier === 3, `found=${JSON.stringify(found)}`);
  }

  // ---------- 17. "soon" window does NOT silently become the entire day — a meeting beyond 4h is excluded ----------
  {
    const calClient = getCalendarClient();
    const start = new Date(now.getTime() + 6 * 3600000);
    await calClient.createEvent({ kind: 'create', title: 'CP28 Beyond Soon Test', start: start.toISOString(), end: new Date(start.getTime() + 1800000).toISOString(), timezone: 'UTC', attendees: [] });
    const scope: AttentionScope = { kind: 'soon', label: 'soon', rangeStart: now.toISOString(), rangeEnd: new Date(now.getTime() + SOON_WINDOW_MINUTES * 60000).toISOString(), tasksDayOffset: 0 };
    const signals = await __rankSignalsForTesting(scope, now);
    const found = signals.find((s) => s.label === 'CP28 Beyond Soon Test');
    check('17. a meeting 6 hours out is EXCLUDED from a "soon" (4h) scope — never masquerades as "soon"', !found, `signals=${JSON.stringify(signals.map((s) => s.label))}`);
  }

  // ---------- 18. truncation — Tier-1 bounded to MAX_ATTENTION_ITEMS(5), never fewer/more manufactured ----------
  {
    const overdue = Array.from({ length: 8 }, (_, i) => task(`o${i}`, `Overdue ${i}`, '2026-08-01T00:00:00.000Z'));
    const signals = rankAttentionSignals({ calendarEvents: [], tasksOverdue: overdue, tasksDueInScope: [], gmailUnread: [] }, now);
    check('18. the engine itself returns the FULL unbounded list (8 overdue) — truncation is the runner\'s own concern, proven separately', signals.length === 8);
  }

  // ---------- 19-23. "right now" is a genuine QUERY WINDOW at the fetch
  // level, not merely a Tier-1 classification threshold — CP28 HOLD fix.
  // Prior to the fix, MockCalendarClient's (and the real Google API's own)
  // exclusive upper-bound `listEvents`/`timeMax` semantics meant a meeting
  // starting at EXACTLY +60m was silently never fetched at all, even though
  // rankAttentionSignals' own Tier-1 comparison (`start <= soonCutoff`) is
  // written inclusive — an unreachable promise. toBriefingScope() now pads
  // the CALENDAR FETCH's upper bound by 1s for right_now/soon scopes only
  // (never for 'day' scopes — CP27's own day-boundary exclusivity at
  // midnight is untouched) so the boundary instant is retrieved and the
  // engine's own comparison decides its tier. These 5 tests go through the
  // REAL fetch (__rankSignalsForTesting -> toBriefingScope -> listEvents),
  // not the bypassed pure function, because that fetch boundary is exactly
  // what was broken.
  {
    const calClient = getCalendarClient();
    (calClient as any).events = [];
    const offsets = [30, 60, 61, 180, 360]; // minutes
    for (const off of offsets) {
      const start = new Date(now.getTime() + off * 60000);
      await calClient.createEvent({ kind: 'create', title: `RN+${off}m`, start: start.toISOString(), end: new Date(start.getTime() + 1800000).toISOString(), timezone: 'UTC', attendees: [] });
    }
    const scope: AttentionScope = { kind: 'right_now', label: 'right now', rangeStart: now.toISOString(), rangeEnd: new Date(now.getTime() + MEETING_SOON_MINUTES * 60000).toISOString(), tasksDayOffset: 0 };
    const signals = await __rankSignalsForTesting(scope, now);
    const byOffset = (off: number) => signals.find((s) => s.label === `RN+${off}m`);

    check('19. right_now +30m is Tier-1 meeting_soon', byOffset(30)?.tier === 1 && byOffset(30)?.reason === 'meeting_soon');
    check('20. right_now +60m EXACT is retrieved and Tier-1 (inclusive far boundary — the HOLD fix)', byOffset(60)?.tier === 1 && byOffset(60)?.reason === 'meeting_soon', `found=${JSON.stringify(byOffset(60))}`);
    check('21. right_now +61m does not appear AT ALL — not Tier-1, not Tier-3, not anywhere', !byOffset(61), `found=${JSON.stringify(byOffset(61))}`);
    check('22. right_now +3h (180m) does not appear at all — never leaks in as a "later" item', !byOffset(180));
    check('23. right_now +6h (360m) does not appear at all', !byOffset(360));
    (calClient as any).events = [];
  }

  // ---------- 24-25. "soon" (4h) far-boundary — same fix, opposite end ----------
  {
    const calClient = getCalendarClient();
    const offsets = [239, 240, 241]; // minutes
    for (const off of offsets) {
      const start = new Date(now.getTime() + off * 60000);
      await calClient.createEvent({ kind: 'create', title: `SOON+${off}m`, start: start.toISOString(), end: new Date(start.getTime() + 1800000).toISOString(), timezone: 'UTC', attendees: [] });
    }
    const scope: AttentionScope = { kind: 'soon', label: 'soon', rangeStart: now.toISOString(), rangeEnd: new Date(now.getTime() + SOON_WINDOW_MINUTES * 60000).toISOString(), tasksDayOffset: 0 };
    const signals = await __rankSignalsForTesting(scope, now);
    const byOffset = (off: number) => signals.find((s) => s.label === `SOON+${off}m`);

    check('24. soon +240m EXACT is retrieved and Tier-3 (inclusive far boundary — the HOLD fix)', byOffset(240)?.tier === 3 && byOffset(240)?.reason === 'meeting_upcoming', `found=${JSON.stringify(byOffset(240))}`);
    check('25. soon +241m does not appear at all — correctly excluded beyond the 4h window', !byOffset(241));
    check('25b. soon +239m (already-passing case) still Tier-3, unaffected by the pad', byOffset(239)?.tier === 3);
    (calClient as any).events = [];
  }

  // ---------- 26-28. Tasks/Gmail semantics under "right now" — date-only
  // Tasks and Gmail recency are NOT narrowed to 60 minutes; only Calendar's
  // own upcoming-meeting window is. Intentional and documented (CP28 HOLD).
  {
    const calClient = getCalendarClient();
    const tasksClient = getTasksClient();
    (calClient as any).events = [];
    const overdueDue = new Date(now.getTime() - 2 * 86400000).toISOString();
    const todayDue = dayRangeIso(0).start;
    await tasksClient.createTask({ kind: 'create', title: 'RN Overdue Task', due: overdueDue, taskListId: tasksClient.defaultListId });
    await tasksClient.createTask({ kind: 'create', title: 'RN Due-Today Task', due: todayDue, taskListId: tasksClient.defaultListId });

    const scope: AttentionScope = { kind: 'right_now', label: 'right now', rangeStart: now.toISOString(), rangeEnd: new Date(now.getTime() + MEETING_SOON_MINUTES * 60000).toISOString(), tasksDayOffset: 0 };
    const signals = await __rankSignalsForTesting(scope, now);

    check('26. an overdue task appears as Tier-1 under a right_now query, regardless of the 60-min Calendar window', !!signals.find((s) => s.label === 'RN Overdue Task' && s.tier === 1 && s.reason === 'task_overdue'));
    check('27. a task due "today" (date-only) appears as Tier-2 under a right_now query — never narrowed to an invented clock time', !!signals.find((s) => s.label === 'RN Due-Today Task' && s.tier === 2 && s.reason === 'task_due'));
    check('28. unread Gmail still appears as Tier-2 under a right_now query, via its own existing (non-time-windowed) recency rule', signals.some((s) => s.source === 'gmail' && s.tier === 2));
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
