/**
 * Post-Checkpoint-20 production-path fix — a small, reusable, deterministic
 * "is this a personal query about topic X" classifier, shared by Gmail/
 * Calendar/Tasks' read-intent detection instead of each capability
 * enumerating exact sentence shapes (which cannot scale to real natural
 * language: "What emails did I get today?" and "What are all the emails I
 * got today?" and "Show me all emails from today" are the same REQUEST,
 * phrased three different ways, and a fourth phrasing will always exist).
 *
 * Design: separate WHAT the sentence is about (a capability's own concept
 * vocabulary — email/mail/inbox, calendar/meeting/event, task/reminder)
 * from HOW it's asked (an interrogative/imperative query shape). Each
 * capability's intent.ts still owns its own concept vocabulary and its own
 * explicit mutation-trigger regexes (draft/schedule/remind-me-to/etc,
 * completely unchanged by this file) — this module only replaces the
 * growing pile of near-duplicate "what/who/did/any + concept word" READ
 * patterns with one shared shape check, reused three times rather than
 * reimplemented three times. Still 100% deterministic — no LLM anywhere in
 * this path, and this module never itself constitutes a mutation or a
 * confirmation; it only decides whether a request is even a QUERY.
 *
 * Two tiers, so an unrelated generic question ("What is email marketing?")
 * is not swept in just because it happens to mention a concept word:
 *   - STRONG shape words (did/any/who) are personal-activity words on their
 *     own no one asks "who is email" or "any email marketing" generically
 *     — so these need no extra signal.
 *   - WEAK shape words (what/is/are/do/does/show/list/find/search/check/
 *     tell) are shared with genuine informational questions, so they only
 *     count as a personal query when paired with an explicit personal or
 *     temporal marker (my/I/me/today/tomorrow/latest/recent/new).
 */

const STRONG_QUERY_SHAPE_RE = /^\s*(?:did|any|who)\b/i;
const WEAK_QUERY_SHAPE_RE = /^\s*(?:what(?:'s)?|is|are|do|does|show|list|find|search(?: for)?|check|tell)\b/i;
const PERSONAL_OR_TEMPORAL_RE = /\b(?:my|i|me|today|tomorrow|yesterday|latest|recent|new|this week|next week)\b/i;

/**
 * True when `text` reads as a personal query (not a generic informational
 * question) about a topic — call with a capability's own concept regex
 * already tested true. Does not itself check the concept vocabulary.
 */
export function isPersonalQueryShape(text: string): boolean {
  if (STRONG_QUERY_SHAPE_RE.test(text)) return true;
  if (WEAK_QUERY_SHAPE_RE.test(text)) return PERSONAL_OR_TEMPORAL_RE.test(text);
  return false;
}
