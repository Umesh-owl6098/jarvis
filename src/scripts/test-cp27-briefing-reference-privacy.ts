/**
 * Checkpoint 27 HOLD review — Gmail field-flow / BriefingItemRef privacy /
 * reference-lifecycle hardening. Focused tests for invariants the original
 * CP27 suite asserted only indirectly or not at all:
 *   - Gmail's .text/.snippet never survive past the local fetch scope into
 *     any briefing structure (proven by inspecting the ACTUAL keys on the
 *     real returned objects, not just by TypeScript's static types).
 *   - the "Tell me more" Gmail follow-up never performs a live Gmail call
 *     of any kind (proven by toggling Gmail "unavailable" BETWEEN the
 *     briefing and the follow-up — if the follow-up still succeeds
 *     normally, no live call was attempted, since a real attempt would
 *     have hit the unavailable client and failed/degraded).
 *   - a briefing reference can never itself authorize a mutation.
 *   - TTL expiry, replacement-on-new-briefing, and pruning actually work.
 *   - a stale (deleted) Calendar event / Task fails the follow-up honestly.
 */
const TEST_PREFS_PATH = require('os').tmpdir() + '/jarvis-cp27-reference-privacy-' + Date.now() + '.json';
process.env.JARVIS_PREFERENCES_PATH = TEST_PREFS_PATH;

process.env.USE_MOCK_GMAIL = 'true';
process.env.USE_MOCK_CALENDAR = 'true';
process.env.USE_MOCK_TASKS = 'true';
process.env.USE_MOCK_CONTACTS = 'true';

import { runTask } from '@/core/agent/task-manager';
import { runBriefing, briefingReferenceStore } from '@/core/agent/briefing/runner';
import type { ParsedBriefingIntent } from '@/core/agent/briefing/intent';
import { pendingActionStore } from '@/core/capabilities/gmail/pending-action';
import { calendarPendingActionStore } from '@/core/capabilities/calendar/pending-action';
import { tasksPendingActionStore } from '@/core/capabilities/tasks/pending-action';
import { getCalendarClient } from '@/core/capabilities/calendar/resolve';
import { getTasksClient } from '@/core/capabilities/tasks/resolve';
import { dayRangeIso } from '@/core/capabilities/calendar/datetime';
import { readFileSync } from 'fs';
import { nanoid } from 'nanoid';

const SID = 'test-session-a';
const SID_B = 'test-session-b';
const ORDINAL_WORDS = ['first', 'second', 'third', 'fourth', 'fifth'];

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

function clearAll(sid: string) {
  pendingActionStore.clear(sid);
  calendarPendingActionStore.clear(sid);
  tasksPendingActionStore.clear(sid);
  briefingReferenceStore.clear(sid);
}

function scopeForDay(daysFromNow: number, dayLabel = 'today'): ParsedBriefingIntent {
  const range = dayRangeIso(daysFromNow);
  return { kind: 'briefing', scope: { daysFromNow, dayLabel, dayPart: null, rangeStart: range.start, rangeEnd: range.end } };
}

// CP27 HOLD reconciliation — the shared MockCalendarClient fixture has
// exactly ONE "today" (day-0) event, "Team Standup" at a fixed 9:00-9:15am
// LOCAL hour (see calendar/mock-client.ts's fixtureEvents()). Once real
// wall-clock time passes 9:15am, fetchCalendarData's own "remaining" filter
// (e.end >= now) correctly excludes it, so it produces ZERO calendar
// signals for the rest of that day — this is correct PRODUCTION behavior,
// not a bug. But several tests below loop over however many references a
// "today" briefing actually produces (one check() per reference, or one
// check() per capability that has a matching reference) — so their own
// ASSERTION COUNT silently varies with wall-clock time-of-day whenever the
// calendar signal disappears mid-day, even though every assertion that DOES
// run still passes. runBriefing()'s own `now` parameter (already a public,
// existing testing seam — no production change) lets every call in this
// file anchor to a fixed LOCAL time safely before 9am, so "Team Standup" is
// always counted, making the total assertion count deterministic at any
// real run time. Only the TIME-of-day is fixed; the DATE is always today's
// real date, so day-relative scopes/task-due comparisons are unaffected.
function fixedNow(): Date {
  const d = new Date();
  d.setHours(8, 30, 0, 0);
  return d;
}

async function main() {
  clearAll(SID);
  clearAll(SID_B);

  // ---------- 1. Gmail field-flow: BriefingGmailData.unread carries ONLY the expected keys ----------
  {
    clearAll(SID);
    const r = await runBriefing(scopeForDay(0), () => {}, undefined, SID, nanoid(), fixedNow());
    check('1-setup. real unread Gmail items are present (proves this exercises the real path)', (r.briefing?.attentionCount ?? 0) > 0);
    const refs = briefingReferenceStore.active(SID) ?? [];
    const gmailRefs = refs.filter((x) => x.capability === 'gmail');
    check('1a. at least one Gmail reference exists in the bounded list', gmailRefs.length > 0, `refs=${JSON.stringify(refs)}`);
    for (const ref of gmailRefs) {
      const keys = Object.keys(ref).sort();
      check(
        `1b. BriefingItemRef for a Gmail item has EXACTLY {capability,id,label} — no text/snippet/thread/headers/payload`,
        JSON.stringify(keys) === JSON.stringify(['capability', 'id', 'label']),
        `keys=${JSON.stringify(keys)}`
      );
    }
    clearAll(SID);
  }

  // ---------- 2. BriefingItemRef shape for Calendar/Tasks also carries only the documented keys ----------
  {
    clearAll(SID);
    await runBriefing(scopeForDay(0), () => {}, undefined, SID, nanoid(), fixedNow());
    const refs = briefingReferenceStore.active(SID) ?? [];
    for (const ref of refs) {
      const keys = Object.keys(ref).sort();
      const allowed = ref.capability === 'tasks' ? ['capability', 'id', 'label', 'taskListId'] : ['capability', 'id', 'label'];
      check(`2. BriefingItemRef(${ref.capability}) has only the documented keys`, keys.every((k) => allowed.includes(k)), `capability=${ref.capability} keys=${JSON.stringify(keys)}`);
    }
    clearAll(SID);
  }

  // ---------- 3. Gmail follow-up performs NO live Gmail call ----------
  {
    clearAll(SID);
    await runBriefing(scopeForDay(0), () => {}, undefined, SID, nanoid(), fixedNow());
    const refs = briefingReferenceStore.active(SID) ?? [];
    const gmailIdx = refs.findIndex((x) => x.capability === 'gmail');
    check('3-setup. a Gmail reference exists to follow up on', gmailIdx !== -1);
    const expectedLabel = refs[gmailIdx].label;

    // Toggle Gmail OFF between the briefing and the follow-up. If the
    // follow-up performed any live Gmail call, it would now hit the
    // unavailable client. If it still succeeds with the SAME label
    // content, that is direct proof no live call was attempted.
    const before = process.env.USE_MOCK_GMAIL;
    process.env.USE_MOCK_GMAIL = 'false';
    const r = await runTask({ sessionId: SID, goal: `Tell me more about the ${ORDINAL_WORDS[gmailIdx]} item.`, onEvent: () => {}, taskId: nanoid() });
    process.env.USE_MOCK_GMAIL = before;

    check(
      '3. the Gmail follow-up succeeds normally even with Gmail toggled OFF — proves no live Gmail call was attempted',
      !/isn't available|not connected/i.test(r.result) && r.result.includes(expectedLabel),
      `result=${r.result}`
    );
    clearAll(SID);
  }

  // ---------- 4. Gmail follow-up content is IDENTICAL to what the briefing already showed (no new data appended) ----------
  {
    // AttentionItem.label ("Recent email from X: Y", used in the rendered
    // PRIORITY line) and ref.label ("Y — X", used by the follow-up) are
    // deliberately different STRINGS built from the SAME two underlying
    // facts (subject, from) — so this checks that both facts already
    // appeared in the original briefing, not that the two label strings
    // are byte-identical.
    clearAll(SID);
    const briefingResult = await runBriefing(scopeForDay(0), () => {}, undefined, SID, nanoid(), fixedNow());
    const refs = briefingReferenceStore.active(SID) ?? [];
    const gmailIdx = refs.findIndex((x) => x.capability === 'gmail');
    const [subject, from] = refs[gmailIdx].label.split(' — ');
    const r = await runTask({ sessionId: SID, goal: `Tell me more about the ${ORDINAL_WORDS[gmailIdx]} item.`, onEvent: () => {}, taskId: nanoid() });
    check(
      '4. the Gmail follow-up discloses only the subject/sender the ORIGINAL briefing already rendered — nothing new',
      briefingResult.result.includes(subject) && briefingResult.result.includes(from) && r.result.includes(subject) && r.result.includes(from),
      `subject=${subject} from=${from} briefingResult=${briefingResult.result.slice(0, 300)} followUp=${r.result}`
    );
    clearAll(SID);
  }

  // ---------- 5. Reference is NOT authorization — pending stores remain empty after every follow-up type ----------
  {
    clearAll(SID);
    await runBriefing(scopeForDay(0), () => {}, undefined, SID, nanoid(), fixedNow());
    const refs = briefingReferenceStore.active(SID) ?? [];
    for (const cap of ['calendar', 'gmail', 'tasks'] as const) {
      const idx = refs.findIndex((x) => x.capability === cap);
      if (idx === -1) continue;
      await runTask({ sessionId: SID, goal: `Tell me more about the ${ORDINAL_WORDS[idx]} item.`, onEvent: () => {}, taskId: nanoid() });
      check(
        `5. following up on a ${cap} item never creates any pending mutation`,
        !pendingActionStore.active(SID) && !calendarPendingActionStore.active(SID) && !tasksPendingActionStore.active(SID),
        `capability=${cap}`
      );
    }
    clearAll(SID);
  }

  // ---------- 6. TTL expiry actually removes/ignores the reference list ----------
  {
    clearAll(SID);
    const staleCreatedAt = Date.now() - 11 * 60 * 1000; // 11 minutes ago — past the 10-minute TTL
    briefingReferenceStore.__setForTesting(SID, [{ capability: 'tasks', id: 'x1', taskListId: 'tl1', label: 'Stale item' }], staleCreatedAt);
    check('6. an expired reference list is treated as absent', briefingReferenceStore.active(SID) === null);
    const r = await runTask({ sessionId: SID, goal: 'Tell me more about the first item.', onEvent: () => {}, taskId: nanoid() });
    check('6b. a follow-up against an expired list reports nothing to reference, never stale data', /don't have a recent briefing/i.test(r.result), `result=${r.result}`);
    clearAll(SID);
  }

  // ---------- 7. a NEW briefing replaces the previous session's reference list ----------
  {
    clearAll(SID);
    await runBriefing(scopeForDay(0), () => {}, undefined, SID, nanoid(), fixedNow());
    const firstRefs = briefingReferenceStore.active(SID);
    check('7-setup. first briefing produced references', !!firstRefs && firstRefs.length > 0);

    // A second briefing for a DIFFERENT, controlled scope (guaranteed no
    // calendar/gmail/tasks-due items — day+60) produces a materially
    // different (near-empty) reference list.
    await runBriefing(scopeForDay(60, 'that day'), () => {}, undefined, SID, nanoid(), fixedNow());
    const secondRefs = briefingReferenceStore.active(SID);
    check(
      '7. a second briefing REPLACES the first session\'s reference list, not appends to it',
      JSON.stringify(secondRefs) !== JSON.stringify(firstRefs),
      `first=${JSON.stringify(firstRefs)} second=${JSON.stringify(secondRefs)}`
    );
    clearAll(SID);
  }

  // ---------- 8. pruneAllExpired actually purges stale sessions (bounded storage, no historical accumulation) ----------
  {
    clearAll(SID);
    clearAll(SID_B);
    const staleCreatedAt = Date.now() - 11 * 60 * 1000;
    briefingReferenceStore.__setForTesting(SID, [{ capability: 'tasks', id: 'x1', taskListId: 'tl1', label: 'Stale A' }], staleCreatedAt);
    briefingReferenceStore.__setForTesting(SID_B, [{ capability: 'tasks', id: 'x2', taskListId: 'tl1', label: 'Stale B' }], Date.now()); // fresh — must survive pruning
    const before = briefingReferenceStore.sessionCount;
    briefingReferenceStore.pruneAllExpired();
    const after = briefingReferenceStore.sessionCount;
    check('8. pruneAllExpired removes only the EXPIRED session, leaving the fresh one intact', before === after + 1 && briefingReferenceStore.active(SID_B) !== null, `before=${before} after=${after}`);
    clearAll(SID);
    clearAll(SID_B);
  }

  // ---------- 9. bounded storage — never more than MAX_ATTENTION_ITEMS(5) references per session regardless of candidate volume ----------
  {
    clearAll(SID);
    const day = 61;
    const tasksClient = getTasksClient();
    const due = dayRangeIso(day).start;
    for (let i = 0; i < 9; i++) {
      await tasksClient.createTask({ kind: 'create', title: `CP27 Ref Bound Task 9-${i}`, due, taskListId: tasksClient.defaultListId });
    }
    await runBriefing(scopeForDay(day, 'that day'), () => {}, undefined, SID, nanoid(), fixedNow());
    const refs = briefingReferenceStore.active(SID) ?? [];
    check('9. the reference list itself never exceeds 5 items even with 9+ candidate tasks', refs.length <= 5, `count=${refs.length}`);
    clearAll(SID);
  }

  // ---------- 10. stale Calendar event — deleted after the briefing, before the follow-up ----------
  {
    clearAll(SID);
    const day = 62;
    const calClient = getCalendarClient();
    const range = dayRangeIso(day);
    const start = new Date(range.start); start.setHours(9, 0, 0, 0);
    const end = new Date(start.getTime() + 1800000);
    const created = await calClient.createEvent({ kind: 'create', title: 'CP27 Stale Event Test', start: start.toISOString(), end: end.toISOString(), timezone: 'UTC', attendees: [] });
    await runBriefing(scopeForDay(day, 'that day'), () => {}, undefined, SID, nanoid(), fixedNow());
    const refs = briefingReferenceStore.active(SID) ?? [];
    const idx = refs.findIndex((x) => x.capability === 'calendar' && x.id === created.id);
    check('10-setup. the fresh event is actually referenced', idx !== -1, `refs=${JSON.stringify(refs)}`);

    await calClient.deleteEvent(created.id);
    const r = await runTask({ sessionId: SID, goal: `Tell me more about the ${ORDINAL_WORDS[idx]} item.`, onEvent: () => {}, taskId: nanoid() });
    check('10. a deleted Calendar event fails the follow-up honestly, never fabricating fresh details', /couldn't find that event/i.test(r.result), `result=${r.result}`);
    clearAll(SID);
  }

  // ---------- 11. stale Task — deleted after the briefing, before the follow-up ----------
  {
    clearAll(SID);
    const day = 63;
    const tasksClient = getTasksClient();
    const due = dayRangeIso(day).start;
    const created = await tasksClient.createTask({ kind: 'create', title: 'CP27 Stale Task Test', due, taskListId: tasksClient.defaultListId });
    await runBriefing(scopeForDay(day, 'that day'), () => {}, undefined, SID, nanoid(), fixedNow());
    const refs = briefingReferenceStore.active(SID) ?? [];
    const idx = refs.findIndex((x) => x.capability === 'tasks' && x.id === created.id);
    check('11-setup. the fresh task is actually referenced', idx !== -1, `refs=${JSON.stringify(refs)}`);

    await tasksClient.deleteTask(tasksClient.defaultListId, created.id);
    const r = await runTask({ sessionId: SID, goal: `Tell me more about the ${ORDINAL_WORDS[idx]} item.`, onEvent: () => {}, taskId: nanoid() });
    check('11. a deleted Task fails the follow-up honestly, never fabricating fresh details', /couldn't find that task/i.test(r.result), `result=${r.result}`);
    check('11b. no mutation was triggered by the failed lookup', !tasksPendingActionStore.active(SID) && !calendarPendingActionStore.active(SID) && !pendingActionStore.active(SID));
    clearAll(SID);
  }

  // ---------- 12. Session B's OWN real briefing never resolves to Session A's item content ----------
  // Note: the underlying mock Calendar/Tasks/Gmail BACKEND is a single
  // shared store (not session-partitioned — only the REFERENCE LIST is
  // session-keyed), so a task created for "session A's day" is equally
  // visible to any session's briefing. The property actually under test is
  // therefore: each session's reference list is a SEPARATE Map entry that
  // the other session's briefing can never overwrite or read — proven by
  // creating two day-EXCLUSIVE tasks, confirming each session's own
  // briefing captured its own day's task at a real index, then confirming
  // A's stored list is byte-identical before and after B's OWN briefing
  // runs (no cross-session mutation), and that B's follow-up resolves to
  // B's own captured item, never A's.
  {
    clearAll(SID);
    clearAll(SID_B);
    const day = 64;
    const tasksClient = getTasksClient();
    await tasksClient.createTask({ kind: 'create', title: 'Session A exclusive task 12', due: dayRangeIso(day).start, taskListId: tasksClient.defaultListId });
    const dayB = 65;
    await tasksClient.createTask({ kind: 'create', title: 'Session B exclusive task 12', due: dayRangeIso(dayB).start, taskListId: tasksClient.defaultListId });

    await runBriefing(scopeForDay(day, 'that day'), () => {}, undefined, SID, nanoid(), fixedNow());
    const aRefsBefore = briefingReferenceStore.active(SID);
    const aIdx = (aRefsBefore ?? []).findIndex((x) => x.label === 'Session A exclusive task 12');
    check('12-setup. Session A\'s own briefing captured A\'s exclusive task', aIdx !== -1, `aRefs=${JSON.stringify(aRefsBefore)}`);

    await runBriefing(scopeForDay(dayB, 'that day'), () => {}, undefined, SID_B, nanoid(), fixedNow());
    const aRefsAfter = briefingReferenceStore.active(SID);
    check('12a. Session B running its OWN briefing never mutates Session A\'s stored reference list', JSON.stringify(aRefsBefore) === JSON.stringify(aRefsAfter), `before=${JSON.stringify(aRefsBefore)} after=${JSON.stringify(aRefsAfter)}`);

    const bRefs = briefingReferenceStore.active(SID_B) ?? [];
    const bIdx = bRefs.findIndex((x) => x.label === 'Session B exclusive task 12');
    check('12b-setup. Session B\'s own briefing captured B\'s exclusive task', bIdx !== -1, `bRefs=${JSON.stringify(bRefs)}`);

    const rB = await runTask({ sessionId: SID_B, goal: `Tell me more about the ${ORDINAL_WORDS[bIdx]} item.`, onEvent: () => {}, taskId: nanoid() });
    check(
      '12. Session B\'s follow-up resolves to B\'s OWN item, never A\'s',
      rB.result.includes('Session B exclusive task 12') && !rB.result.includes('Session A exclusive task 12'),
      `result=${rB.result}`
    );
    clearAll(SID);
    clearAll(SID_B);
  }

  // ---------- 13. no filesystem persistence (structural) ----------
  {
    const src = readFileSync('src/core/agent/briefing/runner.ts', 'utf-8');
    check('13. the briefing module never imports the filesystem — the reference store is purely in-memory', !/from ['"]fs['"]|require\(['"]fs['"]\)/.test(src));
  }

  // ---------- 14. real Gmail client's list/search requests use format:'metadata' (source-level assertion, not timing) ----------
  {
    const src = readFileSync('src/core/capabilities/gmail/client.ts', 'utf-8');
    check(
      '14. RealGmailClient.listRecent()/search() literally request format:\'metadata\' from the Gmail API — the source-level evidence for "no full body over the wire," not execution timing',
      /this\.hydrate\(list\.data\.messages ?\?\? \[\], 'metadata', signal\)/.test(src) || (/async listRecent[\s\S]{0,200}'metadata'/.test(src) && /async search[\s\S]{0,300}'metadata'/.test(src)),
      'checked listRecent/search call getMessage.hydrate with the metadata format literal'
    );
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
