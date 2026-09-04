/**
 * Checkpoint 27 — deterministic briefing-request grammar. No LLM: a small,
 * fixed set of trigger phrases (each one requires an explicit personal
 * marker baked directly into the phrase itself — "brief ME", "MY
 * briefing", "what needs MY attention", "what should I handle", "MY day",
 * "catch ME up" — except the two "what's going on/coming up" phrasings,
 * which are guarded separately below) plus one narrow negative guard for
 * generic/world-scope questions.
 *
 * Deliberately NOT built on query-shape.ts's isPersonalQueryShape() — that
 * helper only recognizes INTERROGATIVE shapes (what/is/are/did/who/...),
 * but half of this grammar's own required positive examples are
 * IMPERATIVE ("Brief me...", "Give me...", "Catch me up...") and would
 * never match it. This grammar's personal-ness comes from the literal
 * trigger words themselves, not from a shared interrogative-shape check.
 */

import { resolveDayPhrase, resolveDayPart, dayRangeIso, dayPartRangeIso } from '@/core/capabilities/calendar/datetime';
import type { BriefingScope } from './types';

// Each alternative is independently sufficient — every one of the required
// positive examples matches exactly one of these, and none of the required
// negative examples matches any of them (verified against all 9 positive /
// 5 negative examples during design; see CP27 report).
const BRIEFING_TRIGGER_RE =
  /\bbrief\s+me\b|\bmy\s+(?:daily\s+|morning\s+|afternoon\s+|evening\s+)?briefing\b|\bwhat(?:'s|\s+is)\s+going\s+on\b|\bwhat(?:'s|\s+is)\s+coming\s+up\b|\bwhat\s+needs\s+my\s+attention\b|\bwhat\s+should\s+i\s+handle\s+first\b|\boverview\s+of\s+my\s+day\b|\bcatch\s+me\s+up\b/i;

// "What's going on today?" is a supported briefing request; "What's going
// on in the world today?" is a generic news question and must NOT be
// stolen — the only reliable structural difference between the two
// phrasings is an explicit world/global/topic scope marker.
//
// Checkpoint 28 — added "in technology" (narrow, additive): CP28's own
// negative-example testing surfaced that "What's coming up in technology?"
// already matched this file's bare "what's coming up" trigger (the guard
// only ever covered "the world"/"the news"-style scope markers, never a
// generic topic-domain noun), so a caller checking CP27 AFTER CP28 would
// have re-swallowed a phrase CP28 correctly declined — failing "generic
// queries must reach their normal route end-to-end." No existing CP27
// positive example contains "technology" — zero behavior change to any
// previously-approved phrase; regression-tested in
// test-cp27-briefing-parsing.ts.
const GENERIC_SCOPE_GUARD_RE = /\b(?:in the world|around the world|globally|worldwide|world news|the news|in technology)\b/i;

// Checkpoint 27 §19 — a compound "briefing + explicit mutation" sentence
// ("Brief me on my day and create a task to prepare for my meeting.")
// must never be silently narrowed to just the briefing half. Deliberately
// a small curated verb list (same "narrow, not a general parser"
// philosophy as orchestrator's own UNSUPPORTED_ACTION_RE), checked only
// once a briefing trigger has already matched.
//
// Checkpoint 28 — exported (via detectCompoundTail below) so
// attention/intent.ts can reuse the EXACT same curated verb list rather
// than maintaining a second, driftable copy — CP28 needs the identical
// "read-only request + mutation tail" rejection behavior CP27 already
// established.
const COMPOUND_TAIL_RE =
  /\b(?:and|then)\b\s+((?:create|add|remind me to|schedule|draft|send|email|cancel|delete|complete|mark)\b.*)$/i;

/** Returns the trailing mutation-request text if `text` contains a compound "...and/then <mutation verb>..." tail, else null. Shared by briefing and attention intent grammars. */
export function detectCompoundTail(text: string): string | null {
  const m = COMPOUND_TAIL_RE.exec(text);
  return m ? m[1].trim() : null;
}

export type ParsedBriefingIntent =
  | { kind: 'briefing'; scope: BriefingScope }
  | { kind: 'unsupported_compound'; scope: BriefingScope; tailText: string };

function buildScope(text: string): BriefingScope {
  // Reuses Calendar's OWN day/daypart resolution and boundary conventions
  // (see calendar/datetime.ts) rather than inventing new ones — "today" is
  // the default when no day phrase is present at all, matching every other
  // capability's own default in this codebase.
  const day = resolveDayPhrase(text) ?? { daysFromNow: 0, label: 'today' };
  const dayPart = resolveDayPart(text);
  const range = dayPart ? dayPartRangeIso(day.daysFromNow, dayPart) : dayRangeIso(day.daysFromNow);
  return { daysFromNow: day.daysFromNow, dayLabel: day.label, dayPart, rangeStart: range.start, rangeEnd: range.end };
}

/**
 * Returns null when `text` is not a recognized briefing request at all —
 * callers fall through to normal single-capability/browser routing,
 * completely unchanged. Never called on retrieved Gmail/Calendar/Tasks
 * content — only on the raw top-level user command, same discipline as
 * every other intent detector in this codebase.
 */
export function detectBriefingIntent(text: string): ParsedBriefingIntent | null {
  const t = text.trim();
  if (!BRIEFING_TRIGGER_RE.test(t)) return null;
  if (GENERIC_SCOPE_GUARD_RE.test(t)) return null;

  const scope = buildScope(t);

  const compoundMatch = COMPOUND_TAIL_RE.exec(t);
  if (compoundMatch) {
    return { kind: 'unsupported_compound', scope, tailText: compoundMatch[1].trim() };
  }

  return { kind: 'briefing', scope };
}

// ============================================================
// Bounded follow-up: "Tell me more about the second item."
// ============================================================

const ORDINALS: Record<string, number> = {
  first: 0, '1st': 0,
  second: 1, '2nd': 1,
  third: 2, '3rd': 2,
  fourth: 3, '4th': 3,
  fifth: 4, '5th': 4,
};

const TELL_ME_MORE_RE =
  /^(?:tell me more about|more (?:about|on)|details? (?:on|about))\s+(?:the\s+)?(first|second|third|fourth|fifth|1st|2nd|3rd|4th|5th)\s+item\b/i;

/** Returns the 0-based index into the last briefing's bounded attention list, or null if `text` isn't this narrow follow-up shape at all. */
export function detectBriefingFollowUp(text: string): number | null {
  const m = TELL_ME_MORE_RE.exec(text.trim());
  if (!m) return null;
  return ORDINALS[m[1].toLowerCase()] ?? null;
}
