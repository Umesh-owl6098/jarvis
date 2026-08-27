/**
 * Checkpoint 18 §7-8 — deterministic Calendar intent parsing. No LLM call
 * to decide WHICH Calendar operation a task names or to extract
 * date/time/attendees — same deterministic-first discipline as
 * gmail/intent.ts.
 */

import {
  resolveDayPhrase,
  resolveDayPart,
  resolveClockTime,
  resolveDurationMinutes,
  isoAt,
  dayRangeIso,
  dayPartRangeIso,
  DEFAULT_TIMEZONE,
  type DayPart,
} from './datetime';
import type { CalendarPendingActionType } from './pending-action';

export type CalendarOperation = 'list' | 'search' | 'freebusy' | 'propose_create' | 'propose_update' | 'propose_cancel';

export interface CalendarIntent {
  operation: CalendarOperation;
  raw: string;
  timezone: string;
  /** list/freebusy */
  rangeStart?: string;
  rangeEnd?: string;
  /** search / update / cancel target resolution */
  searchQuery?: string;
  /** propose_create */
  title?: string;
  attendees?: string[];
  /** Checkpoint 19 — a candidate attendee NAME ("with Ramesh") for Contacts resolution, set only when no explicit email was found. */
  attendeeNameHint?: string;
  location?: string;
  durationMinutes?: number;
  proposedStart?: string;
  proposedEnd?: string;
  /** Set when only a vague part-of-day was given for a create — §12: may suggest a slot, never silently pick one. */
  dayPartOnly?: DayPart;
  /** Set when date/time genuinely couldn't be resolved — callers must ask for clarification, never guess (§6). */
  needsClarification?: string;
  /** propose_update — the NEW clock time only; runner.ts combines it with the target event's OWN existing date unless newDay overrides it, since "move my 3pm meeting to 4pm" never names a date at all. */
  newClockTime?: { hour: number; minute: number };
  newDay?: { daysFromNow: number };
  /** propose_update — the OLD time mentioned, if any ("move my 3 PM meeting..."); runner.ts uses this as a time-based lookup fallback when the text search alone finds nothing, since no event is literally titled with its own start time. */
  oldClockTime?: { hour: number; minute: number };
}

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w-]+/g;

const CALENDAR_WEBSITE_NAV_RE = /\b(?:open|go to|navigate to|visit)\s+(?:calendar\.google\.com|google\s+calendar)\b/i;

// Checkpoint 19 — an explicit Gmail draft/send verb phrase always belongs to
// Gmail, even when the message BODY happens to contain calendar-sounding
// words. Caught live: "Draft an email to John Smith saying are you free
// today" tripped FREEBUSY_RE below (a plain substring match with no
// awareness that "are you free" was quoted inside a "saying ..." email
// body), sending an explicit Gmail draft request to Calendar instead. This
// guard mirrors GMAIL_WEBSITE_NAV_RE's own defensive top-of-function check
// in gmail/intent.ts, just in the opposite direction.
const GMAIL_EMAIL_VERB_RE = /\b(?:draft|write|compose|send|reply|forward)\b.{0,20}\b(?:an?\s+)?(?:email|message)\b/i;

// "calendar" is included alongside the generic nouns (not a full
// noun-requirement removal, unlike CREATE_VERB_RE — "cancel"/"delete"/
// "remove" are common English verbs used in plenty of non-calendar
// contexts, e.g. "delete this file," so broadening ALL the way to "any
// following noun" would misroute unrelated tasks). This specifically
// covers a CUSTOM event title that happens to mention "calendar" (caught
// live: "Cancel my JARVIS Calendar Integration Test" has no
// event/meeting/appointment word at all, so the original regex fell
// through to browser routing entirely on the checkpoint's own test event).
const CANCEL_VERB_RE = /\b(?:cancel|delete|remove)\b.{0,40}\b(?:appointment|event|meeting|calendar)\b/i;
const UPDATE_VERB_RE = /\b(?:move|reschedule|change)\b.{0,40}\b(?:appointment|event|meeting|calendar)?\b/i;
// Deliberately does NOT require a generic noun ("meeting"/"event"/etc.) —
// a custom event title ("schedule a JARVIS Calendar Integration Test...")
// never contains one, and requiring it silently misrouted such requests to
// the browser path entirely (caught via real-account testing). Just needs
// the create verb plus "a/an" — titleFrom() extracts whatever follows.
const CREATE_VERB_RE = /\b(?:schedule|create|book|set up)\b\s+(?:an?\s+)?\S/i;
const FREEBUSY_RE = /\b(?:am i free|are you free|is .+ free|free at|available at|do i have.*free)\b/i;
const LIST_TODAY_RE = /\bwhat(?:'s| is| do i have)\b.{0,20}\b(today|tomorrow)\b|\b(today|tomorrow)\b.{0,20}\bschedule\b|\bmy schedule\b/i;
const SEARCH_RE = /\bfind\b.{0,10}\bmy\b\s+(.+?)\s*(?:appointment|event|meeting)?$/i;

function attendeesFrom(text: string): string[] {
  return [...new Set((text.match(EMAIL_RE) ?? []).map((e) => e.toLowerCase()))];
}

/** Checkpoint 19 — "schedule a meeting WITH Ramesh tomorrow..." -> "Ramesh", a candidate name for Contacts resolution. Only used when no explicit email was already found (an email always wins over a name in the same phrase). */
function attendeeNameFrom(text: string): string | undefined {
  const m = /\bwith\s+([A-Z][\w'-]*(?:\s+[A-Z][\w'-]*)?)\b/.exec(text);
  return m?.[1];
}

function titleFrom(text: string): string {
  // "schedule a meeting with Alex tomorrow at 3 PM for 30 minutes" -> "Meeting with Alex"
  const m = /\b(?:schedule|create|book|set up)\s+(?:a\s+)?(.+?)(?:\s+(?:tomorrow|today|next\s+\w+|on\s+\w+|at\s+\d|for\s+\d|for\s+an?\s+hour)\b|$)/i.exec(text);
  const raw = (m?.[1] ?? 'Meeting').trim();
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

/**
 * Strips verbs/filler/date-time words out of a cancel/update phrase so the
 * remaining text is a clean search query — matched live: "Cancel my dentist
 * appointment tomorrow." was searching for the literal terms
 * "my dentist tomorrow." (mock's AND-of-terms search found nothing, since
 * "tomorrow." never appears in any event's title/description) instead of
 * just "dentist", which actually matches.
 */
function stripSearchNoise(text: string): string {
  return text
    .replace(/\b(?:cancel|delete|remove|move|reschedule|change)\b/gi, '')
    .replace(/\b(?:my|the|a|an)\b/gi, '')
    .replace(/\b(?:appointment|event|meeting)\b/gi, '')
    .replace(/\btoday\b|\btomorrow\b|\bnext\s+\w+\b|\b(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/gi, '')
    .replace(/\bat\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/gi, '')
    .replace(/\bto\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/gi, '')
    .replace(/[.,!?]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The NEW time in an update phrase — specifically after "to", so "move my 3 PM meeting to 4 PM" resolves the target time as 4 PM, not the OLD 3 PM mentioned earlier in the same sentence. */
function newTimeFrom(text: string): { hour: number; minute: number } | null {
  const m = /\bto\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i.exec(text);
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  const minute = m[2] ? parseInt(m[2], 10) : 0;
  const meridiem = m[3]?.toLowerCase();
  if (hour > 23 || minute > 59) return null;
  if (meridiem === 'pm' && hour < 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;
  if (!meridiem) return null; // "to 4" alone is too ambiguous without am/pm
  return { hour, minute };
}

/**
 * The OLD time in an update phrase — the clock time mentioned BEFORE "to"
 * ("move my 3 PM meeting to 4 PM"). Text search alone cannot find "my 3 PM
 * meeting" since no real event is TITLED with its own start time — this is
 * used as a time-based lookup fallback in runner.ts when a plain keyword
 * search comes up empty.
 */
export function oldTimeFrom(text: string): { hour: number; minute: number } | null {
  const beforeTo = text.split(/\bto\s+\d/i)[0];
  return resolveClockTime(beforeTo);
}

/** Unambiguous, action-specific confirmation phrases — recognized regardless of pending state (so a stale/repeat confirmation gets an honest answer, mirroring gmail/intent.ts's isUnambiguousSendPhrase). */
export function unambiguousCalendarPhraseType(text: string): CalendarPendingActionType | null {
  const t = text.trim().toLowerCase();
  if (/^(create it|book it|schedule it|yes,?\s*create it)\.?!?$/.test(t)) return 'calendar_create';
  if (/^(update it|move it|reschedule it|yes,?\s*update it)\.?!?$/.test(t)) return 'calendar_update';
  if (/^(cancel it|delete it|remove it|yes,?\s*cancel it)\.?!?$/.test(t)) return 'calendar_delete';
  return null;
}

/** Ambiguous bare confirmations — only ever consulted by task-manager.ts when a non-expired pending action of the matching type already exists. */
export function isAmbiguousCalendarConfirmPhrase(text: string): boolean {
  const t = text.trim().toLowerCase();
  return /^(confirm(ed)?|go ahead|yes)\.?!?$/.test(t);
}

/** Explicit rejection — deliberately NOT the bare word "cancel" (that's claimed by "cancel it" as the delete-confirmation phrase above); avoids the two colliding. */
export function isCalendarRejectPhrase(text: string): boolean {
  const t = text.trim().toLowerCase();
  return /^(no|don'?t (?:do (?:that|it)|create it|update it|delete it)|never mind|abort|stop)\.?!?$/.test(t);
}

function resolveCreateTiming(text: string): Pick<CalendarIntent, 'proposedStart' | 'proposedEnd' | 'dayPartOnly' | 'needsClarification' | 'durationMinutes'> {
  const day = resolveDayPhrase(text);
  const clock = resolveClockTime(text);
  const duration = resolveDurationMinutes(text) ?? 30;

  if (day && clock) {
    const start = isoAt(day.daysFromNow, clock.hour, clock.minute);
    const end = new Date(new Date(start).getTime() + duration * 60000).toISOString();
    return { proposedStart: start, proposedEnd: end, durationMinutes: duration };
  }

  const dayPart = resolveDayPart(text);
  if (day && dayPart) {
    // §12 — exact time not specified, only a day-part; the runner may
    // inspect free/busy within this window and suggest a slot, but this
    // function itself never picks one — that's not "resolving a time,"
    // that's guessing one.
    return { dayPartOnly: dayPart, durationMinutes: duration };
  }

  if (!day) {
    return { needsClarification: 'No date was found in the request (e.g. "tomorrow", "Friday", "next Monday").', durationMinutes: duration };
  }
  return { needsClarification: 'No specific time was found in the request — only a date. Please specify a time (e.g. "at 3 PM") or a part of day (e.g. "afternoon").', durationMinutes: duration };
}

export function detectCalendarIntent(task: string): CalendarIntent | null {
  const t = task.trim();
  const timezone = DEFAULT_TIMEZONE;
  if (CALENDAR_WEBSITE_NAV_RE.test(t)) return null;
  if (GMAIL_EMAIL_VERB_RE.test(t)) return null;

  if (CANCEL_VERB_RE.test(t)) {
    const targetHint = stripSearchNoise(t);
    return { operation: 'propose_cancel', raw: t, timezone, searchQuery: targetHint || t };
  }

  if (UPDATE_VERB_RE.test(t) && /\b(?:appointment|event|meeting|calendar)\b/i.test(t)) {
    // The NEW time is specifically what follows "to" ("move my 3 PM meeting
    // TO 4 PM") — resolveClockTime would otherwise grab the OLD 3 PM
    // mentioned earlier in the same sentence. No explicit new date is
    // required here: runner.ts defaults to the FOUND event's own existing
    // date when newDay isn't given, since "move it to 4pm" never names one.
    const clock = newTimeFrom(t);
    const oldClock = oldTimeFrom(t);
    const day = resolveDayPhrase(t);
    const targetHint = stripSearchNoise(t);
    return {
      operation: 'propose_update',
      raw: t,
      timezone,
      searchQuery: targetHint,
      newClockTime: clock ?? undefined,
      newDay: day ?? undefined,
      oldClockTime: oldClock ?? undefined,
      needsClarification: !clock ? 'Could not resolve the new time for this update (e.g. "to 4 PM").' : undefined,
    };
  }

  if (CREATE_VERB_RE.test(t)) {
    const timing = resolveCreateTiming(t);
    const attendees = attendeesFrom(t);
    return {
      operation: 'propose_create',
      raw: t,
      timezone,
      title: titleFrom(t),
      attendees,
      attendeeNameHint: attendees.length === 0 ? attendeeNameFrom(t) : undefined,
      location: undefined,
      ...timing,
    };
  }

  if (FREEBUSY_RE.test(t)) {
    const day = resolveDayPhrase(t) ?? { daysFromNow: 0, label: 'today' };
    const clock = resolveClockTime(t);
    if (clock) {
      const start = isoAt(day.daysFromNow, clock.hour, clock.minute);
      const end = new Date(new Date(start).getTime() + 30 * 60000).toISOString();
      return { operation: 'freebusy', raw: t, timezone, rangeStart: start, rangeEnd: end };
    }
    const dayPart = resolveDayPart(t);
    const range = dayPart ? dayPartRangeIso(day.daysFromNow, dayPart) : dayRangeIso(day.daysFromNow);
    return { operation: 'freebusy', raw: t, timezone, rangeStart: range.start, rangeEnd: range.end };
  }

  const searchMatch = SEARCH_RE.exec(t);
  if (searchMatch) {
    return { operation: 'search', raw: t, timezone, searchQuery: searchMatch[1].trim() };
  }

  if (LIST_TODAY_RE.test(t) || /\bwhat (?:meetings|events) do i have\b/i.test(t) || /\bevents? (?:between|from)\b/i.test(t)) {
    const day = resolveDayPhrase(t) ?? { daysFromNow: 0, label: 'today' };
    const dayPart = resolveDayPart(t);
    const range = dayPart ? dayPartRangeIso(day.daysFromNow, dayPart) : dayRangeIso(day.daysFromNow);
    return { operation: 'list', raw: t, timezone, rangeStart: range.start, rangeEnd: range.end };
  }

  return null;
}
