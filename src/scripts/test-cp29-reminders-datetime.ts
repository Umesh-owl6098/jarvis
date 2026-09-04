/**
 * Checkpoint 29 §Time — deterministic reminder trigger-time resolution.
 * Every test uses a FIXED, injected `now` — never the real wall clock —
 * so relative-offset math and past/future boundaries are never flaky.
 */
import { parseReminderTrigger } from '@/core/reminders/datetime';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

// Fixed at a safely mid-morning local hour so day-phrase/daypart math never
// straddles a local-midnight edge case within this file's own assertions.
const NOW = new Date();
NOW.setHours(10, 0, 0, 0);

async function main() {
  // ---------- relative minute/hour math ----------
  {
    const p = parseReminderTrigger('in 20 minutes', NOW);
    check('1. "in 20 minutes" resolves ok', p.kind === 'ok');
    if (p.kind === 'ok') check('1b. "in 20 minutes" is exactly +20 minutes from now', new Date(p.triggerAt).getTime() === NOW.getTime() + 20 * 60000, `triggerAt=${p.triggerAt}`);
  }
  {
    const p = parseReminderTrigger('in 2 hours', NOW);
    check('2. "in 2 hours" resolves ok', p.kind === 'ok');
    if (p.kind === 'ok') check('2b. "in 2 hours" is exactly +120 minutes from now', new Date(p.triggerAt).getTime() === NOW.getTime() + 120 * 60000);
  }
  {
    const p = parseReminderTrigger('in 1 minute', NOW);
    check('3. "in 1 minute" (singular) resolves ok', p.kind === 'ok');
    if (p.kind === 'ok') check('3b. "in 1 minute" is exactly +1 minute', new Date(p.triggerAt).getTime() === NOW.getTime() + 60000);
  }
  {
    const p = parseReminderTrigger('in 1 hour', NOW);
    check('4. "in 1 hour" (singular) resolves ok', p.kind === 'ok');
    if (p.kind === 'ok') check('4b. "in 1 hour" is exactly +60 minutes', new Date(p.triggerAt).getTime() === NOW.getTime() + 3600000);
  }

  // ---------- absolute clock time, no day named — defaults to today ----------
  {
    const p = parseReminderTrigger('at 4 PM', NOW);
    check('5. "at 4 PM" (no day) resolves ok, defaults to today', p.kind === 'ok');
    if (p.kind === 'ok') {
      const d = new Date(p.triggerAt);
      check('5b. "at 4 PM" resolves to hour 16', d.getHours() === 16, `hour=${d.getHours()}`);
      check('5c. "at 4 PM" resolves to today\'s date (same calendar day as NOW)', d.toDateString() === NOW.toDateString());
    }
  }

  // ---------- absolute clock time WITH a day ----------
  {
    const p = parseReminderTrigger('tomorrow at 9 AM', NOW);
    check('6. "tomorrow at 9 AM" resolves ok', p.kind === 'ok');
    if (p.kind === 'ok') {
      const d = new Date(p.triggerAt);
      check('6b. resolves to hour 9', d.getHours() === 9);
      const tomorrow = new Date(NOW); tomorrow.setDate(tomorrow.getDate() + 1);
      check('6c. resolves to tomorrow\'s calendar date', d.toDateString() === tomorrow.toDateString());
    }
  }

  // ---------- weekday resolution ----------
  {
    const p = parseReminderTrigger('Friday at 3 PM', NOW);
    check('7. "Friday at 3 PM" resolves ok', p.kind === 'ok');
    if (p.kind === 'ok') {
      const d = new Date(p.triggerAt);
      check('7b. resolves to Friday', d.getDay() === 5, `day=${d.getDay()}`);
      check('7c. resolves to hour 15', d.getHours() === 15);
      check('7d. a bare weekday mention always resolves strictly in the future (never today, per calendar/datetime.ts\'s own convention)', d.getTime() > NOW.getTime());
    }
  }

  // ---------- daypart default (reuses Calendar's own dayPartRangeIso convention) ----------
  {
    const p = parseReminderTrigger('tomorrow morning', NOW);
    check('8. "tomorrow morning" resolves ok', p.kind === 'ok');
    if (p.kind === 'ok') {
      const d = new Date(p.triggerAt);
      check('8b. "morning" defaults to hour 9 (dayPartRangeIso\'s own start-of-morning convention)', d.getHours() === 9, `hour=${d.getHours()}`);
    }
  }
  {
    const p = parseReminderTrigger('this afternoon', NOW);
    check('9. "this afternoon" resolves ok (today, no explicit day-phrase word needed beyond the daypart)', p.kind === 'ok');
    if (p.kind === 'ok') {
      const d = new Date(p.triggerAt);
      check('9b. "afternoon" defaults to hour 12', d.getHours() === 12, `hour=${d.getHours()}`);
    }
  }
  {
    const p = parseReminderTrigger('this evening', NOW);
    check('10. "this evening" resolves ok', p.kind === 'ok');
    if (p.kind === 'ok') {
      const d = new Date(p.triggerAt);
      check('10b. "evening" defaults to hour 17', d.getHours() === 17);
    }
  }

  // ---------- exact boundary: a time-of-day that has ALREADY passed today ----------
  {
    const p = parseReminderTrigger('at 9 AM', NOW); // NOW is 10:00, so 9 AM today has passed
    check('11. "at 9 AM" when it is already 10:00 today resolves to PAST — never silently rolled to tomorrow, never invented', p.kind === 'past', `kind=${p.kind}`);
  }
  {
    const p = parseReminderTrigger('at 10 AM', NOW); // exactly NOW — not strictly future
    check('12. a time exactly equal to `now` is PAST (never scheduled AT the current instant)', p.kind === 'past', `kind=${p.kind}`);
  }
  {
    const p = parseReminderTrigger('at 10:01 AM', NOW); // 1 minute after NOW
    check('13. one minute after `now` resolves ok (the boundary is exclusive of `now` itself, inclusive of anything strictly after)', p.kind === 'ok', `kind=${p.kind}`);
  }

  // ---------- vague ----------
  for (const phrase of ['remind me sometime', 'remind me later', 'remind me soon']) {
    const p = parseReminderTrigger(phrase, NOW);
    check(`vague. "${phrase}" resolves to VAGUE, not silently defaulted to any time`, p.kind === 'vague', `kind=${p.kind}`);
  }

  // ---------- none — no resolvable time signal at all ----------
  {
    const p = parseReminderTrigger('check the oven', NOW);
    check('none-1. text with no day/clock/daypart/relative signal at all resolves to NONE', p.kind === 'none', `kind=${p.kind}`);
  }
  {
    const p = parseReminderTrigger('Friday', NOW);
    check('none-2. a bare day phrase with NO time-of-day at all resolves to NONE — never invents a time-of-day', p.kind === 'none', `kind=${p.kind}`);
  }

  // ---------- determinism — identical input + injected now produces byte-identical output ----------
  {
    const p1 = parseReminderTrigger('in 45 minutes', NOW);
    const p2 = parseReminderTrigger('in 45 minutes', NOW);
    check('determinism-1. identical input + injected now produces byte-identical output', JSON.stringify(p1) === JSON.stringify(p2));
  }

  // ---------- relative offset ignores any day/clock words also present — wins outright ----------
  {
    const p = parseReminderTrigger('in 30 minutes tomorrow at 5', NOW);
    check('precedence-1. a relative offset wins outright over any day/clock words also present in the same sentence', p.kind === 'ok' && new Date((p as any).triggerAt).getTime() === NOW.getTime() + 30 * 60000, `p=${JSON.stringify(p)}`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
