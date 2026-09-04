/**
 * Checkpoint 29 — deterministic reminder trigger-time resolution. No LLM
 * call to interpret "at 4 PM" or "in 20 minutes" — regex + Date math only,
 * same discipline as calendar/datetime.ts (Checkpoint 18), which this
 * module reuses directly for every piece it already covers (day phrases,
 * clock times, dayparts, full-instant composition via isoAt()) rather than
 * reimplementing them. The one genuine gap calendar/datetime.ts has no
 * equivalent for — a relative "in N minutes/hours from now" offset — is
 * added here, since a Calendar EVENT never needs "N minutes from now"
 * phrasing (events are always about a specific day/time), but a reminder
 * routinely is.
 *
 * Every function here accepts an explicit, injectable `now` (defaulting to
 * `new Date()`) — calendar/datetime.ts's own day/weekday helpers do not
 * (they always read the real wall clock internally), so this module's own
 * "in N minutes" arithmetic and past/future comparison are the actual
 * determinism seam CP29's tests rely on.
 */

import { resolveDayPhrase, resolveDayPart, resolveClockTime, isoAt, dayPartRangeIso, formatLocal, DEFAULT_TIMEZONE } from '@/core/capabilities/calendar/datetime';

export type ReminderTriggerParse =
  | { kind: 'ok'; triggerAt: string; label: string }
  | { kind: 'vague' }
  | { kind: 'past' }
  | { kind: 'none' };

const RELATIVE_RE = /\bin\s+(\d+)\s*(minutes?|mins?|hours?|hrs?)\b/i;
// Deliberately narrow and explicit — only rejected when NO concrete time
// signal was found elsewhere in the text at all (see parseReminderTrigger
// below); a genuinely vague phrase carries no day/clock/daypart/relative
// signal by construction, so checking it only in the "nothing else matched"
// branch can never falsely reject a real, resolvable time.
const VAGUE_RE = /\b(sometime|later|soon)\b/i;

/** "in 20 minutes" / "in 2 hours" — the one relative-offset shape calendar/datetime.ts has no equivalent for. Minutes/hours only (no days — "in 3 days" is already expressible via the day-phrase + clock-time path this module also supports). */
function resolveRelativeOffsetMs(text: string): number | null {
  const m = RELATIVE_RE.exec(text);
  if (!m) return null;
  const amount = parseInt(m[1], 10);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const unit = m[2].toLowerCase();
  const isHours = unit.startsWith('hour') || unit.startsWith('hr');
  return isHours ? amount * 3600000 : amount * 60000;
}

/**
 * Resolves the trigger instant for a reminder command's text, in this
 * precedence order:
 *   1. relative "in N minutes/hours" — always relative to `now`, ignores
 *      any day/clock words also present (an offset already fully
 *      determines the instant; mixing it with e.g. "tomorrow" would be
 *      ambiguous, so the relative form simply wins outright).
 *   2. day phrase (today/tomorrow/Friday/next Friday) + an explicit clock
 *      time ("at 4 PM") or daypart ("morning") — daypart uses
 *      dayPartRangeIso's own START instant as the deterministic default
 *      trigger time, the SAME convention CP27/CP28 already established for
 *      daypart-scoped queries, not a new invented one.
 *   3. an explicit clock time / daypart with NO day phrase — defaults to
 *      TODAY (daysFromNow 0), never silently rolled to tomorrow if that
 *      would already be in the past — see the 'past' outcome below.
 *   4. nothing resolvable — a genuinely vague phrase ("sometime"/"later"/
 *      "soon") is distinguished from a plain missing-time case so the
 *      caller can give an honest, specific rejection either way.
 *
 * A resolved instant at or before `now` is reported as 'past' rather than
 * silently created in the past or silently rolled forward — this function
 * never invents a day the text didn't name.
 */
export function parseReminderTrigger(text: string, now: Date = new Date()): ReminderTriggerParse {
  const relativeMs = resolveRelativeOffsetMs(text);
  if (relativeMs !== null) {
    const triggerAt = new Date(now.getTime() + relativeMs);
    if (triggerAt.getTime() <= now.getTime()) return { kind: 'past' }; // unreachable in practice (amount > 0), kept for defensive symmetry
    return { kind: 'ok', triggerAt: triggerAt.toISOString(), label: formatLocal(triggerAt.toISOString(), DEFAULT_TIMEZONE) };
  }

  const day = resolveDayPhrase(text);
  const clock = resolveClockTime(text);
  const dayPart = resolveDayPart(text);

  if (!clock && !dayPart) {
    if (!day) {
      return VAGUE_RE.test(text) ? { kind: 'vague' } : { kind: 'none' };
    }
    // A day phrase with no time-of-day at all ("remind me Friday to...") —
    // still no resolvable INSTANT; never invents a time-of-day.
    return { kind: 'none' };
  }

  const daysFromNow = day?.daysFromNow ?? 0;
  let triggerIso: string;
  if (clock) {
    triggerIso = isoAt(daysFromNow, clock.hour, clock.minute);
  } else {
    triggerIso = dayPartRangeIso(daysFromNow, dayPart!).start;
  }

  const triggerAt = new Date(triggerIso);
  if (triggerAt.getTime() <= now.getTime()) return { kind: 'past' };

  return { kind: 'ok', triggerAt: triggerAt.toISOString(), label: formatLocal(triggerAt.toISOString(), DEFAULT_TIMEZONE) };
}
