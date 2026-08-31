/**
 * Checkpoint 22 — deterministic reference resolution. Turns a bounded set
 * of follow-up SHAPES ("What about Friday?", "Draft an email to them...")
 * into either a fully-specified goal string (handed to the EXISTING
 * capability detectors/runners unchanged) or an explicit clarification
 * (never a guess). No LLM anywhere in this file — every resolution is a
 * plain regex match plus a lookup against conversation-context.ts's
 * already-typed, already-privacy-safe state.
 *
 * This module never itself calls a capability runner or touches a
 * PendingAction store — it only decides what TEXT should be parsed next
 * (or that nothing should proceed at all), preserving the architecture's
 * single authoritative execution path: UI/voice -> runTask() -> context
 * resolution -> orchestration/direct capability -> existing runner.
 */

import { conversationContext, type ConversationTurn } from './conversation-context';
import { resolveDayPhrase, DEFAULT_TIMEZONE } from '@/core/capabilities/calendar/datetime';

export interface ContextResolution {
  /** Set when resolution succeeded — hand this text to the normal routing chain instead of the raw goal. */
  rewrittenGoal?: string;
  /** Set when resolution recognized the shape but cannot proceed (expired/ambiguous/unresolved) — return this message directly, never fall through to a guess. */
  blocked?: string;
}

const START_OVER_RE = /^(forget that|start over|forget it|clear (?:that|context)|reset context)\.?!?$/i;

export function isStartOverPhrase(text: string): boolean {
  return START_OVER_RE.test(text.trim().toLowerCase());
}

// ============================================================
// Bare date follow-ups: "What about Friday?", "What about the day after?"
// ============================================================

const RELATIVE_DAY_AFTER_RE = /^(?:and\s+)?(?:what about\s+)?the day after(?:\s+that)?\??$/i;
const WHAT_ABOUT_RE = /^(?:and\s+)?(?:what about|how about)\s+(.+?)\??$/i;

const WEEKDAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/**
 * Renders a target daysFromNow back into a phrase Calendar's/Tasks'
 * EXISTING resolveDayPhrase() will re-resolve to the EXACT same
 * daysFromNow — never a fresh independent computation. "tomorrow"/"today"
 * are exact by construction; for 2-7 days out, the bare weekday name is
 * used because resolveDayPhrase's own "next occurrence, at least 1 day
 * out" formula for a BARE weekday produces the identical number
 * ((idx-today+7)%7 || 7) as the one used here to pick that weekday name in
 * the first place — so the round-trip is provably exact, not a guess.
 * Returns null outside [0,7] rather than extrapolating further.
 */
function daysFromNowToPhrase(n: number): string | null {
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  if (n >= 2 && n <= 7) {
    const targetIdx = (new Date().getDay() + n) % 7;
    return WEEKDAY_NAMES[targetIdx];
  }
  return null;
}

/** Rewrites a prior operation's own trigger phrase with a NEW day word substituted in, reusing exactly the same verb/noun shape the previous turn used so the existing detector parses it identically. */
function rebuildDateQuery(prevTurn: ConversationTurn, dayPhrase: string): string | null {
  if (prevTurn.capability === 'calendar') return `What meetings do I have ${dayPhrase}?`;
  if (prevTurn.capability === 'tasks') return `What tasks do I have ${dayPhrase}?`;
  return null;
}

function tryResolveDateFollowUp(goal: string, sessionId: string): ContextResolution | null {
  const t = goal.trim();
  const isRelative = RELATIVE_DAY_AFTER_RE.test(t);
  const whatAboutMatch = WHAT_ABOUT_RE.exec(t);
  if (!isRelative && !whatAboutMatch) return null;

  const prev = conversationContext.latest(sessionId);
  if (!prev || (prev.capability !== 'calendar' && prev.capability !== 'tasks')) {
    return { blocked: "I don't have a prior calendar or task question to compare that to — please ask the full question (e.g. \"What meetings do I have Friday?\")." };
  }

  let targetDaysFromNow: number | null = null;
  if (isRelative) {
    if (!prev.dateRef) return { blocked: 'I don\'t have a specific prior date to count from — please name the day directly.' };
    targetDaysFromNow = prev.dateRef.daysFromNow + 1;
  } else {
    const captured = whatAboutMatch![1].trim();
    const day = resolveDayPhrase(captured);
    if (!day) return null; // not a recognizable day phrase at all — let normal routing/browser handle it
    targetDaysFromNow = day.daysFromNow;
  }

  const dayPhrase = daysFromNowToPhrase(targetDaysFromNow);
  if (!dayPhrase) {
    return { blocked: 'That\'s further out than I can resolve from a short follow-up — please name the exact day.' };
  }
  const rewritten = rebuildDateQuery(prev, dayPhrase);
  if (!rewritten) return null;
  return { rewrittenGoal: rewritten };
}

// ============================================================
// Pronoun resolution: "Draft an email to them about the meeting."
// ============================================================

const PRONOUN_RE = /\b(them|him|her)\b/i;
const GMAIL_SHAPED_RE = /\b(?:draft|write|compose|email|send)\b/i;

function tryResolvePronoun(goal: string, sessionId: string): ContextResolution | null {
  if (!PRONOUN_RE.test(goal)) return null;
  if (!GMAIL_SHAPED_RE.test(goal)) return null; // only resolve pronouns for an email-shaped command — never overreach into Calendar/Tasks phrasing

  const prev = conversationContext.latest(sessionId);
  if (!prev || !prev.contactRef) return null; // nothing to resolve against — let normal routing ask for an explicit recipient, exactly as it already does

  if (prev.contactRef.ambiguous) {
    return { blocked: `I found multiple contacts matching "${prev.contactRef.query}" earlier — please specify which one you meant before I can draft anything.` };
  }
  if (!prev.contactRef.email) {
    return { blocked: `I couldn't resolve "${prev.contactRef.query}" to a contact earlier, so I don't know who "them" refers to — please name an explicit email address.` };
  }

  return { rewrittenGoal: goal.replace(PRONOUN_RE, prev.contactRef.email) };
}

/**
 * Tries each bounded follow-up shape in turn. Returns null (not a
 * recognized follow-up at all) far more often than not — callers fall
 * through to the ORIGINAL, unmodified goal text and the existing
 * orchestration/single-capability/browser routing, completely unchanged.
 */
export function resolveConversationContext(goal: string, sessionId: string): ContextResolution | null {
  return tryResolvePronoun(goal, sessionId) ?? tryResolveDateFollowUp(goal, sessionId);
}

// re-export for task-manager.ts's context-push logic
export { DEFAULT_TIMEZONE };
