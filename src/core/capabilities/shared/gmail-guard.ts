/**
 * Checkpoint 19 fix, generalized in Checkpoint 20 — an explicit Gmail
 * draft/send verb phrase always belongs to Gmail, even when the message
 * BODY happens to contain words another capability's intent detector would
 * otherwise trigger on (Calendar's "are you free today", Tasks' "remind me
 * to..."). Originally a local const in calendar/intent.ts (CP19); hoisted
 * here so Calendar and Tasks share the exact same guard instead of two
 * copies that could drift apart. Used as a top-of-function early return in
 * each capability's own detectXIntent() — mirrors gmail/intent.ts's own
 * defensive GMAIL_WEBSITE_NAV_RE check, just in the opposite direction.
 */
export const GMAIL_EMAIL_VERB_RE = /\b(?:draft|write|compose|send|reply|forward)\b.{0,20}\b(?:an?\s+)?(?:email|message)\b/i;
