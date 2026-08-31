/**
 * Post-CP23 fix — mirrors gmail-guard.ts's GMAIL_EMAIL_VERB_RE, in the
 * opposite direction: an explicit "create/add/make a task/reminder..."
 * phrase always belongs to Tasks, even though Calendar's own CREATE_VERB_RE
 * (create|book|set up + any following word) is broad enough to otherwise
 * claim it first — caught live via "create a task to call GV tomorrow",
 * which Calendar's detector was matching and building a nonsense event
 * proposal titled "Task to call GV" from, before Tasks' own (narrower)
 * detector ever got a chance. Used as a top-of-function early return in
 * calendar/intent.ts's detectCalendarIntent(), same pattern as the Gmail
 * guard.
 */
export const TASKS_CREATE_VERB_RE = /\b(?:create|add|make)\b\s+(?:an?\s+)?(?:task|reminder)\b/i;
