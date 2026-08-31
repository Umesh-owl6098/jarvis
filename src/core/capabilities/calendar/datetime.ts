/**
 * Checkpoint 18 §6 — deterministic date/time/timezone resolution. No LLM
 * call to interpret "tomorrow at 3" or "next Friday" — regex + Date math
 * only, same discipline as the rest of this codebase's deterministic-first
 * approach. Never assumes UTC: every resolved instant is anchored to
 * DEFAULT_TIMEZONE (the machine's own local timezone, the correct proxy
 * for "the user's configured timezone" in a single-user local app — same
 * reasoning as using the OS clock at all) unless CALENDAR_TIMEZONE
 * overrides it.
 */

export const DEFAULT_TIMEZONE =
  process.env.CALENDAR_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/** Local calendar-day boundaries (midnight-to-midnight) for `daysFromNow`, expressed as real Date instants — correct even across DST since it's built from wall-clock components, not a fixed millisecond offset. */
function localDayBounds(daysFromNow: number): { start: Date; end: Date } {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() + daysFromNow, 0, 0, 0, 0);
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + daysFromNow + 1, 0, 0, 0, 0);
  return { start, end };
}

function withTime(date: Date, hour: number, minute: number): Date {
  const d = new Date(date);
  d.setHours(hour, minute, 0, 0);
  return d;
}

/** Days-from-today offset for the next occurrence of a weekday name, strictly in the future (tomorrow at the earliest — never "today" for a bare weekday mention, to avoid an ambiguous same-day-already-passed reading). */
function daysUntilWeekday(name: string): number | null {
  const idx = WEEKDAYS.indexOf(name.toLowerCase());
  if (idx === -1) return null;
  const today = new Date().getDay();
  let delta = (idx - today + 7) % 7;
  if (delta === 0) delta = 7;
  return delta;
}

export type DayPart = 'morning' | 'afternoon' | 'evening';
const DAY_PART_RANGES: Record<DayPart, [number, number]> = {
  morning: [9, 12],
  afternoon: [12, 17],
  evening: [17, 20],
};

export interface ResolvedDay {
  daysFromNow: number;
  label: string;
}

const TIME_RE = /\b(at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/gi;
// "for" is optional — real usage caught live: "Schedule a 10 minute meeting
// with GV tomorrow" names the duration adjectivally, before the noun
// ("10 minute meeting"), not in the trailing "for 10 minutes" form this
// regex originally required. Only used by resolveCreateTiming() for the
// CREATE flow (single caller), so broadening this can't affect update/
// cancel/search intent parsing elsewhere.
const DURATION_RE = /\b(?:for\s+)?(?:(\d+)\s*(?:min(?:ute)?s?)|(?:an?\s+)?hour|(\d+(?:\.\d+)?)\s*hours?)\b/i;
const DAY_PART_RE = /\b(morning|afternoon|evening)\b/i;

/** Resolves "today"/"tomorrow"/"next <weekday>"/bare "<weekday>" to a days-from-now offset. Returns null if no day phrase is present at all (caller decides whether that means "today" by default or "ambiguous"). */
export function resolveDayPhrase(text: string): ResolvedDay | null {
  const t = text.toLowerCase();
  if (/\btoday\b/.test(t)) return { daysFromNow: 0, label: 'today' };
  if (/\btomorrow\b/.test(t)) return { daysFromNow: 1, label: 'tomorrow' };
  const weekdayMatch = /\b(?:next\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i.exec(t);
  if (weekdayMatch) {
    const delta = daysUntilWeekday(weekdayMatch[1]);
    if (delta !== null) return { daysFromNow: delta, label: weekdayMatch[0] };
  }
  return null;
}

export function resolveDayPart(text: string): DayPart | null {
  const m = DAY_PART_RE.exec(text);
  return (m?.[1]?.toLowerCase() as DayPart) ?? null;
}

/**
 * Resolves an explicit clock time ("at 3pm", "3:30 PM", "15:00") to
 * {hour, minute} in 24h form. Returns null if no explicit time is present.
 *
 * Checkpoint 23 fix — TIME_RE is unanchored and, run once, would match the
 * FIRST number-like token in the text — including an unrelated LEADING
 * duration adjective ("a 60 minute meeting... at 2 PM"), which is never a
 * clock time. The fix is structural, not a special case for any specific
 * number: scan EVERY candidate match (global flag) and return the first
 * one carrying an EXPLICIT time signal — an am/pm marker, or the "at"
 * keyword immediately before THAT candidate (not just present anywhere in
 * the text, a looseness the previous version had, since it checked the
 * whole string rather than the specific match). A signal-less bare number
 * (no am/pm, no immediately-preceding "at" — e.g. "60" from "60 minute")
 * is never accepted, exactly as before: this function still only ever
 * resolves an EXPLICIT time, it just no longer lets an earlier, unrelated,
 * implausible number pre-empt a later explicit one in the same sentence.
 */
export function resolveClockTime(text: string): { hour: number; minute: number } | null {
  TIME_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TIME_RE.exec(text))) {
    const hasAtPrefix = !!m[1];
    let hour = parseInt(m[2], 10);
    const minute = m[3] ? parseInt(m[3], 10) : 0;
    const meridiem = m[4]?.toLowerCase();
    if (hour > 23 || minute > 59) continue; // not a plausible clock time at all — e.g. "60" from "60 minute"
    if (!meridiem && !hasAtPrefix) continue; // no explicit signal on THIS candidate — never guessed
    if (meridiem === 'pm' && hour < 12) hour += 12;
    if (meridiem === 'am' && hour === 12) hour = 0;
    return { hour, minute };
  }
  return null;
}

export function resolveDurationMinutes(text: string): number | null {
  const m = DURATION_RE.exec(text);
  if (!m) return null;
  if (m[1]) return parseInt(m[1], 10);
  if (m[2]) return Math.round(parseFloat(m[2]) * 60);
  return 60; // "for an hour" / "for a hour"
}

export function isoAt(daysFromNow: number, hour: number, minute: number): string {
  const { start } = localDayBounds(daysFromNow);
  return withTime(start, hour, minute).toISOString();
}

export function dayRangeIso(daysFromNow: number): { start: string; end: string } {
  const { start, end } = localDayBounds(daysFromNow);
  return { start: start.toISOString(), end: end.toISOString() };
}

export function dayPartRangeIso(daysFromNow: number, part: DayPart): { start: string; end: string } {
  const [startHour, endHour] = DAY_PART_RANGES[part];
  const { start } = localDayBounds(daysFromNow);
  return { start: withTime(start, startHour, 0).toISOString(), end: withTime(start, endHour, 0).toISOString() };
}

export function formatLocal(iso: string, timezone: string): string {
  return new Date(iso).toLocaleString('en-US', {
    timeZone: timezone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
