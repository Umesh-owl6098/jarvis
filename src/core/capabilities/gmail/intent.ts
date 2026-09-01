/**
 * Checkpoint 17 §6-8 — deterministic Gmail intent parsing. No LLM call to
 * decide WHICH Gmail operation a task names or to extract recipient/
 * subject/body — same "deterministic-first" discipline the rest of this
 * codebase already applies to capability routing and reference resolution.
 * The only LLM call in the whole Gmail path is the SUMMARIZE operation's
 * actual summarization of real fetched text (genuine reasoning over
 * content, not classification) — see gmail-runner.ts.
 *
 * Read-query detection uses the shared concept+shape classifier
 * (capabilities/shared/query-shape.ts) rather than enumerating exact
 * sentence shapes — caught live via the production UI: "What is the
 * latest email I got from Sarah?", "What emails did I get today?", "Did I
 * get any emails today?", "Who emailed me today?" etc. are the same
 * request phrased differently, and patching one exact sentence at a time
 * cannot keep up with real natural language. DRAFT/SUMMARIZE/READ-THREAD/
 * explicit find-search-with-qualifier detection is unchanged — only the
 * final "what does the user want to see" fallback was consolidated.
 */

import { isPersonalQueryShape } from '@/core/capabilities/shared/query-shape';

export type GmailOperation = 'list' | 'search' | 'read' | 'summarize' | 'draft';

export interface GmailIntent {
  operation: GmailOperation;
  raw: string;
  /** search/list */
  searchQuery?: string;
  max?: number;
  /** read/summarize — who/what the target thread should match; 'latest' means most recent overall. */
  targetHint?: string;
  /** draft */
  recipients?: string[];
  cc?: string[];
  subject?: string;
  body?: string;
  /** true when the draft request had no NL body content to extract at all — needs clarification, never guessed (§7/§14E). */
  missingRecipient?: boolean;
  /**
   * Checkpoint 19 — the raw recipient-segment text when no explicit email
   * was found there ("Draft an email to Ramesh..." -> "Ramesh"). A
   * candidate NAME for Contacts resolution, not itself a usable address —
   * gmail/runner.ts attempts resolvePerson() on this before falling back
   * to "missing recipient." Never set alongside a real email match.
   */
  recipientNameHint?: string;
  /**
   * Post-CP23 fix — set only for the bare imperative "email <person>" shape
   * (no draft/write/compose verb, no body content at all — see
   * BARE_EMAIL_RE below). Recipient resolution (including Contacts, if
   * available) still happens normally, but gmail/runner.ts's draft case
   * must ask what the email should say INSTEAD OF creating a draft — a
   * bare "email GV" must never silently produce a real empty-body draft.
   */
  needsBodyClarification?: boolean;
}

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w-]+/g;

// "gmail.com"/"mail.google.com" named explicitly as a DESTINATION to open —
// this is browser navigation, never the Gmail capability (§6's own explicit
// example: "Open gmail.com" -> BROWSER). Checked by capability-router.ts
// BEFORE this module is even consulted, but re-asserted here defensively so
// this module can never be fooled into treating a browser-nav phrase as a
// draft/search/read Gmail intent — see detectGmailIntent's top guard.
const GMAIL_WEBSITE_NAV_RE = /\b(?:open|go to|navigate to|visit)\s+(?:gmail\.com|mail\.google\.com)\b/i;

const DRAFT_RE =
  /\b(?:draft|write|compose)\b.{0,20}\b(?:an?\s+)?(?:email|message)\b.{0,20}\bto\s+([^\n]+?)(?:\s+(?:saying|that says|with the message|about|stating)\s+(.+))?$/is;

// Post-CP23 fix — the bare imperative "email <person>" ("email GV", "Email
// John") with NO draft/write/compose verb and no body content at all.
// Anchored to the START of the command (optionally after "please") so it
// can never match a generic question/statement that merely mentions
// "email" ("What is email marketing?", "Explain email authentication") —
// those never open with the bare verb "email". A short denylist on the
// captured target excludes the one realistic false positive this
// leading-verb anchor alone wouldn't catch: "Email marketing is
// important." also opens with "Email", but as a NOUN, not an imperative
// aimed at a person.
const BARE_EMAIL_RE = /^(?:please\s+)?email\s+(.+?)[.!?]?$/i;
const EMAIL_NON_PERSON_TARGET_RE = /^(marketing|address(?:es)?|provider|client|server|service|app|application|settings|account|security|authentication|signature|list|template)\b/i;

const CC_RE = /\bcc\s+([^\n,]+?)(?:\s+and\s+|,|\s+saying|\s+that says|\s+with the message|$)/i;
const SUBJECT_RE = /\bsubject\s*(?:is|:)?\s*["']?([^"'\n]+?)["']?(?:\s*[,.]|\s+saying|\s+that says|\s+body|$)/i;
const BODY_LABEL_RE = /\bbody\s*(?:is|:)?\s*["']?(.+?)["']?$/i;

// Matched in two independent shapes, tried in order — natural phrasing puts
// "from"/"about" either as the ONLY qualifier ("find the email from John")
// or after a generic "for the X" lead-in ("search my email for the invoice
// from John") that isn't itself part of the query:
//   1. an explicit "from X" and/or "about X" clause anywhere after the verb;
//   2. a bare "search/find ... email/mail for <query>" with no from/about
//      keyword at all — <query> is whatever free text follows "for".
// Requires an explicit "from"/"about" qualifier to match at all — no
// all-optional tail that could "succeed" with nothing captured.
const SEARCH_QUALIFIED_RE =
  /\b(?:find|search(?: for)?)\b.{0,10}\b(?:email|emails|message|messages|mail)\b.*?\bfrom\s+([^\n]+?)(?:\s+about\s+([^\n]+))?$|\b(?:find|search(?: for)?)\b.{0,10}\b(?:email|emails|message|messages|mail)\b.*?\babout\s+([^\n]+)$/i;
const SEARCH_FREEFORM_RE = /\b(?:find|search)\b.{0,10}\b(?:email|emails|message|messages|mail)\b\s+for\s+(?:the\s+)?([^\n]+)$/i;
// Word-based budget (not character count) between "read" and "thread" so
// phrasing length variance ("read my latest thread" vs "read thread")
// doesn't silently fall outside a fixed character window.
const READ_THREAD_RE = /\bread\b(?:\s+\S+){0,4}?\s+thread\b(?:\s+with\s+([^\n]+))?/i;
const SUMMARIZE_RE = /\bsummarize\b.{0,20}\b(?:thread|email|message)\b(?:\s+with\s+([^\n]+))?/i;

// Concept vocabulary for the shared query-shape classifier below. Includes
// verb forms (emailed/emailing) so "Who emailed me today?" still matches —
// \bemails?\b alone does NOT match "emailed" (different word, trailing -ed).
export const GMAIL_CONCEPT_RE = /\bemail(?:s|ed|ing)?\b|\bmails?\b|\binbox\b/i;
const TEMPORAL_ONLY_RE = /^(?:today|tomorrow|yesterday|this week|last week|next week|recently)\.?$/i;

/**
 * Post-Checkpoint-21 fix — a name explicitly named via "from X" or "did X
 * email me" means the SENDER field, not "this word appears anywhere in the
 * message." Caught live: "Find the latest email from Anthropic" matched 10
 * unrelated emails purely because their BODY text happened to mention
 * "Anthropic," none of them actually from Anthropic. Gmail's own search
 * syntax has a native `from:` operator that restricts to the sender field —
 * every "from X" extraction below now builds `from:X` instead of a bare
 * full-text term, so both the real Gmail API (which understands `from:`
 * natively) and the mock (taught the same operator — see mock-client.ts)
 * search sender metadata specifically, not full text, when the user said
 * "from." An explicit non-"from" full-text search (e.g. "find email about
 * invoices") is completely unaffected — only the sender-specific extraction
 * changes.
 */
function toSenderQuery(name: string): string {
  const trimmed = name.trim();
  return trimmed.includes(' ') ? `from:"${trimmed}"` : `from:${trimmed}`;
}

/** A sender NAME the user explicitly asked about — "from X" or "what did X email me" — never a guess, and never a temporal word ("emails from today") misread as a name. Returns a Gmail from:-scoped query, not a bare name. */
function extractGmailSender(t: string): string | undefined {
  const didMatch = /\b(?:what\s+did|did)\s+((?!i\b|you\b|we\b|they\b|he\b|she\b)[\w'-]+(?:\s+[\w'-]+)?)\s+email(?:ed)?\s+me\b/i.exec(t);
  if (didMatch) return toSenderQuery(didMatch[1]);

  const fromMatch = /\bfrom\s+([^\n?.!]+)/i.exec(t);
  if (fromMatch) {
    const candidate = fromMatch[1].replace(/[.,!?]+$/g, '').trim();
    if (candidate && !TEMPORAL_ONLY_RE.test(candidate)) return toSenderQuery(candidate);
  }
  return undefined;
}

/** Strips a from:/from:"..." prefix back off for a human-readable display of what was searched — the query sent to the client stays from:-scoped; only the shown text is friendlier. */
export function humanizeSenderQuery(q: string): string {
  const m = /^from:"([^"]+)"$/.exec(q) ?? /^from:(\S+)$/.exec(q);
  return m ? `from ${m[1]}` : q;
}

function parseRecipients(text: string): string[] {
  return [...new Set((text.match(EMAIL_RE) ?? []).map((e) => e.toLowerCase()))];
}

/**
 * §9's "generic 'yes' may be acceptable only when it unambiguously refers
 * to the immediately pending send confirmation" splits into two tiers:
 *
 *   - UNAMBIGUOUS phrases ("send it", "send the email") name sending an
 *     email by their own vocabulary — safe to recognize even when nothing
 *     happens to be pending right now, so a STALE or REPEATED "send it"
 *     (already consumed, or nothing was ever drafted) gets an honest
 *     Gmail-scoped "nothing pending" answer instead of silently falling
 *     through to unrelated browser routing (task-manager.ts checks this
 *     one regardless of pending state).
 *   - AMBIGUOUS bare words ("yes", "confirm", "go ahead") could mean
 *     anything depending on what was just asked — task-manager.ts only
 *     consults isSendConfirmationPhrase for these, and ONLY when a
 *     non-expired PendingAction already exists, so a bare "yes" with
 *     nothing Gmail-related pending is never hijacked into a Gmail reply.
 */
export function isUnambiguousSendPhrase(text: string): boolean {
  const t = text.trim().toLowerCase();
  return /^(send it|send the email|send it now|yes,?\s*send it)\.?!?$/.test(t);
}

export function isSendConfirmationPhrase(text: string): boolean {
  const t = text.trim().toLowerCase();
  return isUnambiguousSendPhrase(t) || /^(confirm(ed)?|go ahead(?: and send)?|yes)\.?!?$/.test(t);
}

/** True for an explicit refusal of a pending send — clears the pending action rather than leaving it to expire. */
export function isSendCancelPhrase(text: string): boolean {
  const t = text.trim().toLowerCase();
  // Checkpoint 22 — "cancel it"/"cancel that" added as bare, AMBIGUOUS
  // pronoun-cancel phrasing (shares the same "exactly one pending active"
  // multi-pending tiebreak as "cancel"/"no" already does — see
  // task-manager.ts's ambiguous-cancel section), not the Gmail-specific
  // unambiguous tier (isGmailSpecificCancelPhrase), since "it"/"that" name
  // no capability specifically.
  return /^(no|don'?t send( it)?|cancel( it| that)?|stop|never mind)\.?!?$/.test(t);
}

/**
 * Checkpoint 21 fix — an UNAMBIGUOUS, Gmail-specific cancel phrase: names
 * "send" or "the email"/"the draft" explicitly, so it's safe to act on
 * regardless of what else is pending (Calendar's/Tasks' own cancel
 * vocabulary never uses "send" or names an email/draft). Needed because
 * Pattern 3's orchestration can leave a Calendar proposal AND a Gmail
 * draft pending simultaneously — the old bare "no"/"cancel"/"never mind"
 * tier requires exactly one store active to act at all, so it could never
 * clear just the Gmail half of a dual-pending state. This is checked
 * BEFORE that ambiguous tier, unconditionally.
 */
export function isGmailSpecificCancelPhrase(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/[.,!?]+$/, '');
  return /^(cancel|don'?t send) the (email|draft|message)$/.test(t) || /^don'?t send( it| the email)?$/.test(t);
}

// Checkpoint 24 — the conversational wrapper a follow-up answer to "What
// would you like the email to say?" is stripped of, deterministically.
// Deliberately narrow: only these four fixed lead-ins are recognized, never
// a creative LLM rewrite of the user's own words. "Tell him I'll be there
// at 4." -> "I'll be there at 4." "I'll be there at 4." (no wrapper at all)
// -> unchanged. This is NOT a general Gmail trigger — it is only ever
// consulted by task-manager.ts's pending-slot completion logic, which
// itself only runs when a gmail_draft_body slot is already active for this
// session (see pending-slot.ts) — a bare "Tell him ..." sentence with no
// active slot never reaches this function at all.
const BODY_WRAPPER_RE = /^(?:tell\s+(?:him|her|them)|say)\s+(?:that\s+)?/i;

/** Strips only an obvious conversational lead-in ("tell him"/"tell her"/"tell them"/"say") off a follow-up answer, preserving the rest of the user's own text verbatim. */
export function extractFollowUpEmailBody(text: string): string {
  return text.trim().replace(BODY_WRAPPER_RE, '').trim();
}

/**
 * Returns null when the task is not a Gmail-capability request at all —
 * callers fall through to the existing read/browser routing unchanged.
 * Deterministic only. Order matters: draft is checked before the narrower
 * search/list/read/summarize patterns since "draft ... to X" could
 * otherwise trip a looser "email" mention.
 */
export function detectGmailIntent(task: string): GmailIntent | null {
  const t = task.trim();
  if (GMAIL_WEBSITE_NAV_RE.test(t)) return null;

  const draftMatch = DRAFT_RE.exec(t);
  if (draftMatch) {
    // Strip a trailing "cc ..." clause OUT of the recipient segment before
    // parsing — otherwise an address named after "cc" gets picked up by
    // BOTH parseRecipients(recipientSegment) (it scans for any email
    // anywhere in the segment, not just the first) and CC_RE below,
    // landing the same address in `to` AND `cc` at once.
    const recipientSegment = (draftMatch[1] ?? '').replace(/\bcc\s+.*/i, '');
    const bodySegment = (draftMatch[2] ?? '').trim();
    const recipients = parseRecipients(recipientSegment);
    const cc = parseRecipients(CC_RE.exec(t)?.[1] ?? '');
    const explicitSubject = SUBJECT_RE.exec(t)?.[1]?.trim();
    const explicitBody = BODY_LABEL_RE.exec(bodySegment)?.[1]?.trim();
    // §19 — no explicit email in the recipient segment, but real text is
    // there ("Ramesh") — a candidate name for Contacts resolution, not a
    // guess at an address. Trimmed of trailing punctuation only.
    const nameHint = recipients.length === 0 ? recipientSegment.replace(/[.,!?]+$/g, '').trim() : '';
    return {
      operation: 'draft',
      raw: t,
      recipients,
      cc: cc.length ? cc : undefined,
      subject: explicitSubject,
      body: explicitBody || bodySegment || undefined,
      missingRecipient: recipients.length === 0,
      recipientNameHint: nameHint || undefined,
    };
  }

  const bareEmailMatch = BARE_EMAIL_RE.exec(t);
  if (bareEmailMatch) {
    const target = bareEmailMatch[1].trim();
    if (target && !EMAIL_NON_PERSON_TARGET_RE.test(target)) {
      const recipients = parseRecipients(target);
      return {
        operation: 'draft',
        raw: t,
        recipients,
        missingRecipient: recipients.length === 0,
        recipientNameHint: recipients.length === 0 ? target.replace(/[.,!?]+$/g, '').trim() : undefined,
        needsBodyClarification: true,
      };
    }
    // A non-person target ("Email marketing is important.") falls through
    // to the existing fallbacks below rather than being treated as a
    // person-directed draft request.
  }

  const summarizeMatch = SUMMARIZE_RE.exec(t);
  if (summarizeMatch) {
    return { operation: 'summarize', raw: t, targetHint: (summarizeMatch[1] ?? 'latest').trim() };
  }

  const readMatch = READ_THREAD_RE.exec(t);
  if (readMatch) {
    return { operation: 'read', raw: t, targetHint: (readMatch[1] ?? 'latest').trim() };
  }

  const qualifiedMatch = SEARCH_QUALIFIED_RE.exec(t);
  if (qualifiedMatch) {
    // group1 = explicit "from X" (sender-scoped, see toSenderQuery's
    // comment), group2 = an optional trailing "about X" alongside it,
    // group3 = a bare "about X" with no "from" clause at all — that one
    // stays plain full-text, since Gmail has no generic "about:" operator.
    const fromPart = qualifiedMatch[1] ? toSenderQuery(qualifiedMatch[1].trim()) : undefined;
    const aboutPart = (qualifiedMatch[2] ?? qualifiedMatch[3])?.trim();
    const query = [fromPart, aboutPart].filter(Boolean).join(' ');
    if (query) {
      return { operation: 'search', raw: t, searchQuery: query, max: 10 };
    }
  }

  const freeformMatch = SEARCH_FREEFORM_RE.exec(t);
  if (freeformMatch) {
    const query = freeformMatch[1].trim();
    if (query) {
      return { operation: 'search', raw: t, searchQuery: query, max: 10 };
    }
  }

  // Final fallback: a personal query ABOUT email, in whatever natural
  // phrasing — everything above already claimed the narrower explicit-verb
  // shapes (draft/summarize/read thread/find-search-with-qualifier); this
  // catches "What emails did I get today?", "Any new emails today?", "Who
  // emailed me today?", "What did John email me?" and similar paraphrases
  // without needing a new regex per sentence. A named sender becomes a
  // SEARCH; otherwise it's a LIST (same default count logic as before).
  if (GMAIL_CONCEPT_RE.test(t) && isPersonalQueryShape(t)) {
    const sender = extractGmailSender(t);
    if (sender) {
      return { operation: 'search', raw: t, searchQuery: sender, max: 10 };
    }
    // §17.1 live test caught this: "Show my latest 3 emails" was silently
    // returning 5 — the user's own explicit count was parsed nowhere.
    // Any digit in the request is used as the count; otherwise default 5.
    const countMatch = /\b(\d+)\b/.exec(t);
    const requested = countMatch ? parseInt(countMatch[1], 10) : 5;
    const max = Number.isFinite(requested) && requested > 0 ? Math.min(requested, 50) : 5;
    return { operation: 'list', raw: t, max };
  }

  return null;
}
