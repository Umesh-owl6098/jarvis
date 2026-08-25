/**
 * Checkpoint 17 §6-8 — deterministic Gmail intent parsing. No LLM call to
 * decide WHICH Gmail operation a task names or to extract recipient/
 * subject/body — same "deterministic-first" discipline the rest of this
 * codebase already applies to capability routing and reference resolution.
 * The only LLM call in the whole Gmail path is the SUMMARIZE operation's
 * actual summarization of real fetched text (genuine reasoning over
 * content, not classification) — see gmail-runner.ts.
 */

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
const LIST_RE = /\b(?:show|list)\b.{0,15}\b(?:latest|recent)\b.{0,10}\bemails?\b/i;
// Word-based budget (not character count) between "read" and "thread" so
// phrasing length variance ("read my latest thread" vs "read thread")
// doesn't silently fall outside a fixed character window.
const READ_THREAD_RE = /\bread\b(?:\s+\S+){0,4}?\s+thread\b(?:\s+with\s+([^\n]+))?/i;
const SUMMARIZE_RE = /\bsummarize\b.{0,20}\b(?:thread|email|message)\b(?:\s+with\s+([^\n]+))?/i;

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
  return /^(no|don'?t send( it)?|cancel|stop|never mind)\.?!?$/.test(t);
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
    return {
      operation: 'draft',
      raw: t,
      recipients,
      cc: cc.length ? cc : undefined,
      subject: explicitSubject,
      body: explicitBody || bodySegment || undefined,
      missingRecipient: recipients.length === 0,
    };
  }

  if (LIST_RE.test(t)) {
    return { operation: 'list', raw: t, max: 5 };
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
    const query = [qualifiedMatch[1], qualifiedMatch[2], qualifiedMatch[3]].filter(Boolean).map((s) => s!.trim()).join(' ');
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

  return null;
}
