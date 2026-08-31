/**
 * Checkpoint 23 — deterministic preference-command parsing. No LLM, same
 * discipline as every other capability's intent.ts. Deliberately NARROW
 * vocabulary ("remember that...", "set my ... to ...", "forget my ...
 * preference", "what ... do I prefer") so an ORDINARY capability command
 * that happens to mention a duration or a style ("Schedule a 45 minute
 * meeting tomorrow.", "Draft a concise email to GV.") never matches — see
 * §4's explicit negative examples. This module is only ever handed the raw
 * top-level user command text (see preferences/runner.ts and where it's
 * called in task-manager.ts) — it NEVER runs against retrieved Gmail/
 * Calendar/Tasks/browser content, which is what keeps prompt injection out
 * (§11): there is no code path from "read an email" to "parse this text as
 * a preference command."
 */

import { resolveDurationMinutes } from '@/core/capabilities/calendar/datetime';
import { isValidEmailStyle, isValidMeetingLocation, type EmailStyle, type MeetingLocation, type PreferenceField } from './types';

export type PreferenceCommand =
  | { kind: 'set'; field: 'meetingDurationMinutes'; value: number }
  | { kind: 'set'; field: 'emailStyle'; value: EmailStyle }
  | { kind: 'set'; field: 'defaultMeetingLocation'; value: MeetingLocation }
  | { kind: 'get'; field: PreferenceField | 'all' }
  | { kind: 'forget'; field: PreferenceField | 'all' };

function clean(s: string): string {
  return s.replace(/[.!]+\s*$/, '').trim();
}

function tryParseDurationSet(t: string): PreferenceCommand | null {
  const m =
    /^remember\s+(?:that\s+)?i\s+prefer\s+(.+)$/i.exec(t) ??
    /^remember\s+(?:that\s+)?my\s+(?:default\s+)?meeting\s+duration\s+is\s+(.+)$/i.exec(t) ??
    /^set\s+my\s+(?:default\s+)?meeting\s+duration\s+to\s+(.+)$/i.exec(t);
  if (!m) return null;
  const clause = clean(m[1]);
  if (!/\bmeetings?\b/i.test(clause) && !/\bmeeting\s+duration\b/i.test(t)) return null;
  const minutes = resolveDurationMinutes(clause);
  if (minutes === null || minutes <= 0 || minutes > 24 * 60) return null;
  return { kind: 'set', field: 'meetingDurationMinutes', value: minutes };
}

function tryParseEmailStyleSet(t: string): PreferenceCommand | null {
  const m =
    /^remember\s+(?:that\s+)?i\s+prefer\s+(.+)$/i.exec(t) ??
    /^remember\s+(?:that\s+)?my\s+emails?\s+should\s+be\s+(.+)$/i.exec(t) ??
    /^remember\s+(?:that\s+)?my\s+email\s+style\s+is\s+(.+)$/i.exec(t) ??
    /^set\s+my\s+email\s+style\s+to\s+(.+)$/i.exec(t);
  if (!m) return null;
  const clause = clean(m[1]).toLowerCase();
  const style = (['concise', 'detailed', 'formal', 'casual'] as const).find((s) => clause.includes(s));
  if (!style || !isValidEmailStyle(style)) return null;
  // Requires the clause to actually be ABOUT email — "I prefer formal
  // clothing" must never be read as an email-style preference.
  if (!/\bemails?\b/i.test(clause) && !/\bemail\b/i.test(t)) return null;
  return { kind: 'set', field: 'emailStyle', value: style };
}

function tryParseLocationSet(t: string): PreferenceCommand | null {
  const m =
    /^remember\s+(?:that\s+)?my\s+(?:default\s+)?meeting\s+location\s+is\s+(.+)$/i.exec(t) ??
    /^set\s+my\s+(?:default\s+)?meeting\s+location\s+to\s+(.+)$/i.exec(t);
  if (!m) return null;
  const clause = clean(m[1]).toLowerCase();
  let value: MeetingLocation | null = null;
  if (/google\s*meet/.test(clause)) value = 'google_meet';
  else if (/^none$/.test(clause.trim())) value = 'none';
  if (!value || !isValidMeetingLocation(value)) return null;
  return { kind: 'set', field: 'defaultMeetingLocation', value };
}

function tryParseGet(t: string): PreferenceCommand | null {
  if (/^what do you remember about my preferences\??$/i.test(t)) return { kind: 'get', field: 'all' };
  if (/^what are my preferences\??$/i.test(t)) return { kind: 'get', field: 'all' };
  if (!/^what/i.test(t)) return null;
  if (/\b(?:default\s+)?meeting\s+duration\b/i.test(t)) return { kind: 'get', field: 'meetingDurationMinutes' };
  if (/\bemail\s+style\b/i.test(t)) return { kind: 'get', field: 'emailStyle' };
  if (/\b(?:default\s+)?meeting\s+location\b/i.test(t)) return { kind: 'get', field: 'defaultMeetingLocation' };
  return null;
}

function tryParseForget(t: string): PreferenceCommand | null {
  if (/^forget\s+all\s+my\s+preferences$/i.test(t)) return { kind: 'forget', field: 'all' };
  if (/^forget\s+my\s+(?:default\s+)?meeting\s+duration(?:\s+preference)?$/i.test(t)) return { kind: 'forget', field: 'meetingDurationMinutes' };
  if (/^forget\s+my\s+email\s+style(?:\s+preference)?$/i.test(t)) return { kind: 'forget', field: 'emailStyle' };
  if (/^forget\s+my\s+(?:default\s+)?meeting\s+location(?:\s+preference)?$/i.test(t)) return { kind: 'forget', field: 'defaultMeetingLocation' };
  return null;
}

/**
 * Returns null far more often than not — an ordinary capability command
 * ("Schedule a 45 minute meeting tomorrow.", "Draft a concise email to
 * GV.", "Make this meeting 30 minutes.") never matches any of the narrow
 * templates above and falls straight through to normal routing, completely
 * unaffected. Order matters only for the SET templates, which all share
 * the "remember that i prefer ..." prefix — duration is tried first, and
 * each template's own success check (a real duration number extracted, a
 * real style/location keyword found) is what prevents cross-matching, not
 * the ordering alone.
 */
export function parsePreferenceCommand(goal: string): PreferenceCommand | null {
  // Trailing punctuation is stripped ONCE, here, for every template below —
  // "Forget my meeting duration preference." must match exactly like
  // "Forget my meeting duration preference" (no period). The SET templates
  // additionally clean() their own captured clause for the same reason.
  const t = clean(goal.trim());
  return (
    tryParseForget(t) ??
    tryParseGet(t) ??
    tryParseDurationSet(t) ??
    tryParseEmailStyleSet(t) ??
    tryParseLocationSet(t)
  );
}
