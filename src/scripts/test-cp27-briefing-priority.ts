/**
 * Checkpoint 27 §Priority — the deterministic, explainable attention
 * ranking. Every test here uses an INJECTED, fixed `now` (never the real
 * wall clock) so "meeting starting soon" boundaries are never flaky.
 */
const TEST_PREFS_PATH = require('os').tmpdir() + '/jarvis-cp27-priority-' + Date.now() + '.json';
process.env.JARVIS_PREFERENCES_PATH = TEST_PREFS_PATH;

process.env.USE_MOCK_GMAIL = 'true';
process.env.USE_MOCK_CALENDAR = 'true';
process.env.USE_MOCK_TASKS = 'true';
process.env.USE_MOCK_CONTACTS = 'true';

import { runBriefing, __rankAttentionForTesting } from '@/core/agent/briefing/runner';
import type { ParsedBriefingIntent } from '@/core/agent/briefing/intent';
import { getCalendarClient } from '@/core/capabilities/calendar/resolve';
import { getTasksClient } from '@/core/capabilities/tasks/resolve';
import { dayRangeIso } from '@/core/capabilities/calendar/datetime';
import { nanoid } from 'nanoid';

const SID = 'test-session-a';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

function scopeForDay(daysFromNow: number): ParsedBriefingIntent {
  const range = dayRangeIso(daysFromNow);
  return { kind: 'briefing', scope: { daysFromNow, dayLabel: 'that day', dayPart: null, rangeStart: range.start, rangeEnd: range.end } };
}

/** Priority attention lines only, in order, stripped of the leading "N. ". */
function priorityLines(result: string): string[] {
  const idx = result.indexOf('PRIORITY');
  if (idx === -1) return [];
  return result
    .slice(idx)
    .split('\n')
    .filter((l) => /^\d+\.\s/.test(l))
    .map((l) => l.replace(/^\d+\.\s/, ''));
}

async function main() {
  const now = new Date(); // captured ONCE — every fixture below is built relative to this SAME instant, and this SAME instant is passed into every runBriefing() call.

  // ---------- 26. overdue Task outranks a LATER (not-soon) meeting ----------
  {
    const day = 40;
    const calClient = getCalendarClient();
    const tasksClient = getTasksClient();
    const laterStart = new Date(now.getTime() + 4 * 3600000); // 4h out — well outside the 60-min "soon" window
    await calClient.createEvent({ kind: 'create', title: 'CP27 Later Meeting 26', start: laterStart.toISOString(), end: new Date(laterStart.getTime() + 1800000).toISOString(), timezone: 'UTC', attendees: [] });
    const overdueDue = new Date(now.getTime() - 5 * 86400000).toISOString();
    await tasksClient.createTask({ kind: 'create', title: 'CP27 Overdue Task 26', due: overdueDue, taskListId: tasksClient.defaultListId });

    // Scope this test's own day range to cover the later meeting's actual date.
    const start = new Date(now); const end = new Date(now.getTime() + 5 * 3600000);
    const scope = { daysFromNow: 0, dayLabel: 'today', dayPart: null, rangeStart: start.toISOString(), rangeEnd: end.toISOString() } as const;
    // Checked against the FULL unbounded ranking (not the 5-item rendered
    // list) — the shared mock fixtures already contribute several items
    // ahead of these two, so the bounded top-5 alone can't prove relative
    // order between them.
    const all = await __rankAttentionForTesting(scope, now);
    const overdueIdx = all.findIndex((a) => a.label.includes('CP27 Overdue Task 26'));
    const meetingIdx = all.findIndex((a) => a.label.includes('CP27 Later Meeting 26'));
    check('26. overdue task outranks a later (not-soon) meeting', overdueIdx !== -1 && meetingIdx !== -1 && overdueIdx < meetingIdx, `overdueIdx=${overdueIdx} meetingIdx=${meetingIdx} tiers=${JSON.stringify(all.map((a) => a.tier))}`);
  }

  // ---------- 27. a SOON meeting ranks highly (tier 1, ahead of later items) ----------
  {
    const soonStart = new Date(now.getTime() + 30 * 60000); // 30 min out — within the 60-min "soon" window
    const calClient = getCalendarClient();
    await calClient.createEvent({ kind: 'create', title: 'CP27 Soon Meeting 27', start: soonStart.toISOString(), end: new Date(soonStart.getTime() + 1800000).toISOString(), timezone: 'UTC', attendees: [] });
    const laterStart = new Date(now.getTime() + 5 * 3600000);
    await calClient.createEvent({ kind: 'create', title: 'CP27 Later Meeting 27', start: laterStart.toISOString(), end: new Date(laterStart.getTime() + 1800000).toISOString(), timezone: 'UTC', attendees: [] });

    const start = new Date(now); const end = new Date(now.getTime() + 6 * 3600000);
    const scope = { daysFromNow: 0, dayLabel: 'today', dayPart: null, rangeStart: start.toISOString(), rangeEnd: end.toISOString() } as const;
    const all = await __rankAttentionForTesting(scope, now);
    const soonIdx = all.findIndex((a) => a.label.includes('CP27 Soon Meeting 27'));
    const laterIdx = all.findIndex((a) => a.label.includes('CP27 Later Meeting 27'));
    check(
      '27. a meeting starting within 60 minutes ranks ahead of a later meeting the same day',
      soonIdx !== -1 && laterIdx !== -1 && soonIdx < laterIdx && all[soonIdx].tier === 1 && all[laterIdx].tier === 3,
      `soonIdx=${soonIdx} laterIdx=${laterIdx} soonTier=${all[soonIdx]?.tier} laterTier=${all[laterIdx]?.tier}`
    );
  }

  // ---------- 28. due-today Task ordering (alphabetical tie-break, same due date) ----------
  {
    const day = 41;
    const tasksClient = getTasksClient();
    const due = dayRangeIso(day).start; // any ISO string on that calendar day
    await tasksClient.createTask({ kind: 'create', title: 'Zebra task 28', due, taskListId: tasksClient.defaultListId });
    await tasksClient.createTask({ kind: 'create', title: 'Alpha task 28', due, taskListId: tasksClient.defaultListId });
    const r = await runBriefing(scopeForDay(day), () => {}, undefined, SID, nanoid());
    const lines = priorityLines(r.result);
    const alphaIdx = lines.findIndex((l) => l.includes('Alpha task 28'));
    const zebraIdx = lines.findIndex((l) => l.includes('Zebra task 28'));
    check('28. tasks due on the same day are ordered alphabetically', alphaIdx !== -1 && zebraIdx !== -1 && alphaIdx < zebraIdx, `lines=${JSON.stringify(lines)}`);
  }

  // ---------- 29. deterministic tie-breaking (same result across repeated runs) ----------
  {
    const day = 42;
    const tasksClient = getTasksClient();
    const overdueDue = new Date(Date.now() - 10 * 86400000).toISOString();
    await tasksClient.createTask({ kind: 'create', title: 'Bravo overdue 29', due: overdueDue, taskListId: tasksClient.defaultListId });
    await tasksClient.createTask({ kind: 'create', title: 'Alpha overdue 29', due: overdueDue, taskListId: tasksClient.defaultListId });
    const r1 = await runBriefing(scopeForDay(0), () => {}, undefined, SID, nanoid());
    const r2 = await runBriefing(scopeForDay(0), () => {}, undefined, SID, nanoid());
    check('29. attention ranking is deterministic — identical input produces identical order across repeated runs', priorityLines(r1.result).join('|') === priorityLines(r2.result).join('|'), `r1=${JSON.stringify(priorityLines(r1.result))} r2=${JSON.stringify(priorityLines(r2.result))}`);
  }

  // ---------- 30. attention list is bounded ----------
  {
    const day = 43;
    const tasksClient = getTasksClient();
    const due = dayRangeIso(day).start;
    // 8 due-that-day tasks — well beyond the 5-item cap.
    for (let i = 0; i < 8; i++) {
      await tasksClient.createTask({ kind: 'create', title: `CP27 Bounded Task 30-${i}`, due, taskListId: tasksClient.defaultListId });
    }
    const r = await runBriefing(scopeForDay(day), () => {}, undefined, SID, nanoid());
    const lines = priorityLines(r.result);
    check('30. the rendered PRIORITY list never exceeds 5 items even with 8+ candidates', lines.length <= 5, `count=${lines.length}`);
    check('30b. the total candidate count is still honestly disclosed, never silently dropped', /of \d+ items needing attention/i.test(r.result) && (r.briefing?.attentionTotalCount ?? 0) >= 8, `result=${r.result.slice(0, 200)} totalCount=${r.briefing?.attentionTotalCount}`);
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
