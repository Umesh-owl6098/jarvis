/**
 * Checkpoint 29 — deterministic reminder intent grammar. No LLM
 * classification — same discipline as every other capability's intent.ts.
 *
 * Collision-free by construction with Tasks' own "remind me to X"
 * (CP20's CREATE_REMIND_RE in tasks/intent.ts, which requires the literal
 * CONTIGUOUS phrase "remind me to" with nothing in between): every CP29
 * create trigger below requires at least one word BETWEEN "remind me" and
 * "to" (a time phrase) — "Remind me to check the oven" (no time) is
 * therefore structurally Tasks' own territory, unchanged; "Remind me at 4
 * PM to check the oven" (a time phrase between them) is CP29's. This
 * module never recognizes a bare "remind me to X" at all — deliberately,
 * so the two capabilities can never both claim the same sentence.
 *
 * List/next/cancel triggers all require the literal word "reminder(s)"
 * combined with list/next/cancel-shaped phrasing — narrow enough that
 * generic/definitional questions ("What is a reminder?", "How do reminders
 * work?") and Tasks' own generic concept-word fallback never collide (this
 * module is checked BEFORE Tasks in task-manager.ts's dispatch order
 * specifically to win phrases like "What reminders do I have?", which
 * Tasks' TASKS_CONCEPT_RE would otherwise also match).
 */

export type ReminderOperation = 'create' | 'list' | 'next' | 'cancel';

export interface ReminderIntent {
  operation: ReminderOperation;
  raw: string;
  /** create only — the raw time-phrase substring, handed to parseReminderTrigger(). */
  timePhrase?: string;
  /** create only — the reminder's own text. */
  text?: string;
  /** cancel only — a plain-terms search phrase used to find the matching scheduled reminder. */
  searchQuery?: string;
}

// Requires a non-empty time phrase between "remind me" and "to" — see the
// module comment above for why this is what keeps Tasks' own "remind me to
// X" completely disjoint.
const CREATE_REMIND_RE = /\bremind\s+me\s+(.+?)\s+to\s+(.+)$/i;
const CREATE_SET_RE = /\bset\s+(?:a\s+)?reminder\s+for\s+(.+?)\s+to\s+(.+)$/i;

const LIST_RE = /\bwhat\s+reminders?\s+do\s+i\s+have\b|\bshow\s+(?:me\s+)?my\s+reminders?\b|\blist\s+(?:my\s+)?reminders?\b/i;
const NEXT_RE = /\bwhat(?:'s|\s+is)\s+my\s+next\s+reminder\b|\bwhen(?:'s|\s+is)\s+my\s+next\s+reminder\b/i;

const CANCEL_RE = /\bcancel\s+(?:my\s+)?reminder\s+(?:to|about|for)\s+(.+)$/i;
const DELETE_RE = /\bdelete\s+(?:the\s+|my\s+)?reminder\s+(?:about|to|for)\s+(.+)$/i;

function stripTrailingPunctuation(s: string): string {
  return s.replace(/[.,!?]+$/g, '').trim();
}

/**
 * Returns null when `text` is not a recognized reminder request — callers
 * fall through to normal Tasks/Calendar/Gmail/browser routing, completely
 * unchanged. A genuinely incomplete reminder command ("Remind me
 * tomorrow.", no reminder text at all) never matches CREATE_REMIND_RE
 * (which requires a trailing " to <text>") and so is simply NOT claimed
 * here — a deliberate scope decision (§14 of the checkpoint): CP29
 * requires a complete one-turn reminder command rather than adding a
 * second missing-field-slot system alongside CP24's.
 */
export function detectReminderIntent(text: string): ReminderIntent | null {
  const t = text.trim();

  const remindMatch = CREATE_REMIND_RE.exec(t) ?? CREATE_SET_RE.exec(t);
  if (remindMatch) {
    const timePhrase = stripTrailingPunctuation(remindMatch[1]);
    const reminderText = stripTrailingPunctuation(remindMatch[2]);
    if (timePhrase && reminderText) {
      return { operation: 'create', raw: t, timePhrase, text: reminderText };
    }
  }

  if (NEXT_RE.test(t)) return { operation: 'next', raw: t };
  if (LIST_RE.test(t)) return { operation: 'list', raw: t };

  const cancelMatch = CANCEL_RE.exec(t) ?? DELETE_RE.exec(t);
  if (cancelMatch) {
    const searchQuery = stripTrailingPunctuation(cancelMatch[1]);
    if (searchQuery) return { operation: 'cancel', raw: t, searchQuery };
  }

  return null;
}
