/**
 * Checkpoint 28 — deterministic personal-attention query grammar. No LLM:
 * a small, fixed set of trigger phrases, each requiring an explicit
 * personal/urgency marker baked directly into the phrase itself, plus
 * reuse of Checkpoint 27's own compound-tail rejection.
 *
 * Deliberate CP27 boundary decisions (see the CP28 architecture report for
 * the full reasoning):
 *   - "What needs my attention right now?" and "What's coming up soon?" /
 *     "Anything coming up soon?" share vocabulary with CP27's own bare
 *     (suffix-unrestricted) triggers. This grammar's own trigger for those
 *     two shapes is deliberately NARROWED to require "right now"/"soon"
 *     specifically, and task-manager.ts checks this module BEFORE CP27's
 *     briefing intent — so CP27's own day-scoped phrasing ("...today?",
 *     "...tomorrow?", bare "What's coming up?") still falls through
 *     untouched, and only the qualified variants route here.
 *   - "What should I handle first?" is CP27's own established trigger with
 *     NO distinguishing scope word at all — there is no safe way to
 *     narrow it, so it is deliberately NOT included here; CP27 keeps
 *     exclusive ownership, unchanged.
 */

import { resolveDayPhrase, resolveDayPart, dayRangeIso, dayPartRangeIso } from '@/core/capabilities/calendar/datetime';
import { detectCompoundTail } from '../briefing/intent';
import { MEETING_SOON_MINUTES, SOON_WINDOW_MINUTES } from './engine';
import type { AttentionScope } from './types';

// Each alternative independently sufficient — verified against every
// required positive/negative example during design (see CP28 report).
const ATTENTION_TRIGGER_RE =
  /\banything\s+urgent\b|\banything\s+i\s+should\s+know\s+about\b|\bwhat\s+should\s+i\s+watch\b|\bwhat\s+needs\s+my\s+attention\s+right\s+now\b|\banything\s+coming\s+up\s+soon\b|\bwhat(?:'s|\s+is)\s+coming\s+up\s+soon\b|\bis\s+there\s+anything\s+important\b/i;

export type ParsedAttentionIntent =
  | { kind: 'attention'; scope: AttentionScope }
  | { kind: 'unsupported_compound'; scope: AttentionScope; tailText: string };

/**
 * Builds the time window for this query. "right now"/"soon" take priority
 * over any day phrase (an urgency query naming BOTH is rare, but immediacy
 * wins); otherwise falls back to Calendar's own existing day/daypart
 * resolution (today/tomorrow/this morning/etc, defaulting to today) —
 * exactly the same conventions Checkpoint 27 already uses. A genuinely
 * bare query with no scope word at all ("Anything urgent?") defaults to
 * "right now" — the tightest, most conservative reading of an immediacy
 * question, never silently widened to the whole day.
 */
function buildScope(text: string, now: Date = new Date()): AttentionScope {
  if (/\bright\s+now\b/i.test(text)) {
    return {
      kind: 'right_now',
      label: 'right now',
      rangeStart: now.toISOString(),
      rangeEnd: new Date(now.getTime() + MEETING_SOON_MINUTES * 60000).toISOString(),
      tasksDayOffset: 0,
    };
  }
  if (/\bsoon\b/i.test(text)) {
    return {
      kind: 'soon',
      label: 'soon',
      rangeStart: now.toISOString(),
      rangeEnd: new Date(now.getTime() + SOON_WINDOW_MINUTES * 60000).toISOString(),
      tasksDayOffset: 0,
    };
  }
  const day = resolveDayPhrase(text);
  const dayPart = resolveDayPart(text);
  if (day || dayPart) {
    const daysFromNow = day?.daysFromNow ?? 0;
    const label = day?.label ?? 'today';
    const range = dayPart ? dayPartRangeIso(daysFromNow, dayPart) : dayRangeIso(daysFromNow);
    return { kind: 'day', label, rangeStart: range.start, rangeEnd: range.end, tasksDayOffset: daysFromNow };
  }
  return {
    kind: 'right_now',
    label: 'right now',
    rangeStart: now.toISOString(),
    rangeEnd: new Date(now.getTime() + MEETING_SOON_MINUTES * 60000).toISOString(),
    tasksDayOffset: 0,
  };
}

/**
 * Returns null when `text` is not a recognized personal-attention request
 * — callers fall through to normal single-capability/CP27-briefing/browser
 * routing, completely unchanged. Never called on retrieved Gmail/Calendar/
 * Tasks content — only on the raw top-level user command.
 */
export function detectAttentionIntent(text: string): ParsedAttentionIntent | null {
  const t = text.trim();
  if (!ATTENTION_TRIGGER_RE.test(t)) return null;

  const scope = buildScope(t);

  const tail = detectCompoundTail(t);
  if (tail) {
    return { kind: 'unsupported_compound', scope, tailText: tail };
  }

  return { kind: 'attention', scope };
}
