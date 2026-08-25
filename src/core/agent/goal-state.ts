import { normalizeUrl } from '@/core/browser/url';
import type { ContentItem } from '@/core/observation';
import { analyzeGoal, isFileLikeToken } from './goal-analysis';

/**
 * TaskProgress: a small, explicit state machine layered on top of the
 * existing observe/plan/act loop.
 *
 * Why this exists: the planner was re-deriving "have I finished?" from
 * scratch on every single call, from prose alone. That is why it could reach
 * the exact page the user asked for and then wander away from it again — it
 * had no persistent record that a target had already been selected and
 * reached. This module tracks that explicitly so the executor can decide
 * "goal satisfied" from observed evidence (a URL match), not from asking an
 * LLM to remember what it did three steps ago.
 *
 * Deliberately small: only a handful of common task shapes get deterministic
 * handling. Anything that doesn't match stays exactly as it was before this
 * checkpoint — the planner decides, as usual. This is a floor under specific
 * well-understood cases, not a general task-understanding system.
 */

export type GoalType =
  | 'navigate' // "Open wikipedia.org"
  | 'navigate_to_target' // "Open the top story" / "Open the cheapest product"
  | 'navigate_and_extract' // "Open wikipedia.org and tell me the title"
  | 'search' // "Search Wikipedia for OpenAI"
  | 'search_and_open' // "Search GitHub for React repositories and open the first result"
  | 'interact' // "Click Sign In"
  | 'unclassified';

export interface GoalClassification {
  goalType: GoalType;
  /** The single named destination, for 'navigate' / 'navigate_and_extract'. */
  namedDestination?: string;
  /** Which end of a ranked list the user wants, for target-selection goals. */
  targetHint?: 'cheapest' | 'priciest' | 'top' | 'first';
  /** The literal search terms, for 'search' / 'search_and_open'. */
  searchQuery?: string;
  /** A simple, unambiguous field name for 'navigate_and_extract' — only set
   *  when the request is a plain "title" or "url" ask; anything else is left
   *  for the planner to actually read and summarize. */
  extractionHint?: 'title' | 'url';
}

export interface SelectedTarget {
  label: string;
  price?: string;
  /** Where reaching this target should land — an href from its ContentItem. */
  destination?: string;
  /** The interactive element id that activates this target, if any. */
  elementId?: string;
  actionRole?: 'link' | 'button' | 'unknown';
  /** Why this one was picked ("lowest price", "first result", ...). */
  reason: string;
  /** The page URL the destination href should be resolved against. */
  resolvedFrom: string;
}

export interface Milestone {
  id: string;
  description: string;
  done: boolean;
}

export type TaskOutcome = 'completed' | 'partial' | 'blocked' | 'failed';

export interface TaskProgress {
  goal: string;
  goalType: GoalType;
  namedDestination?: string;
  extractionHint?: string;
  searchQuery?: string;
  targetHint?: GoalClassification['targetHint'];
  selectedTarget?: SelectedTarget;
  milestones: Milestone[];
  /** Set once a search skill call has succeeded — gates target selection for search_and_open. */
  searchDone: boolean;
  /** True once the executor has already tried an automatic href fallback for the current target. */
  hrefFallbackAttempted: boolean;
}

/* ------------------------------------------------------------------ */
/* Classification                                                      */
/* ------------------------------------------------------------------ */

const DOMAIN_RE = /\b((?:https?:\/\/)?(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?:\/[^\s'"]*)?)/i;

const TARGET_HINT_RE: { re: RegExp; hint: GoalClassification['targetHint'] }[] = [
  { re: /\b(cheapest|least costly|least expensive|lowest[- ]price[d]?)\b/i, hint: 'cheapest' },
  { re: /\b(priciest|most expensive|highest[- ]price[d]?)\b/i, hint: 'priciest' },
  { re: /\b(top|first|latest|newest)\b/i, hint: 'top' },
];

const TARGET_NOUN_RE = /\b(story|item|product|result|article|post|listing|row)\b/i;

/**
 * Deterministic, conservative classification. Every branch requires a
 * fairly literal match — ambiguous phrasing falls through to 'unclassified',
 * which means "no change from pre-Checkpoint-11 behavior" (the planner
 * decides everything, as before).
 */
export function classifyGoal(task: string): GoalClassification {
  const t = task.trim();

  // "search <site> for X and open the first/top result" — checked BEFORE
  // the Checkpoint 15 compound gate below: this pattern, and the two after
  // it, already correctly handle a real "search, then open" dependency
  // within one proven, efficient goal shape (search_and_open's own
  // TaskProgress/searchDone gating) — the compound gate must not preempt a
  // case these patterns already get right, or a task like "search for the
  // first result and open it" gets needlessly routed through full subgoal
  // decomposition for no correctness gain (measured: 3x more browser
  // launches for an identical, already-correct result).
  const searchAndOpen = /\bsearch\b.{0,40}\bfor\b\s+(.+?)\s+and\s+(?:open|select|click)\b/i.exec(t);
  if (searchAndOpen) {
    return { goalType: 'search_and_open', searchQuery: searchAndOpen[1].trim(), targetHint: pickHint(t) ?? 'top' };
  }

  // "search <site>? for X" (no follow-on open clause)
  const searchOnly = /\bsearch\b.{0,40}\bfor\b\s+(.+)$/i.exec(t);
  if (searchOnly && !/\band\b/i.test(searchOnly[1])) {
    return { goalType: 'search', searchQuery: searchOnly[1].trim() };
  }

  // "open/navigate to <domain> and search for X" — Wikipedia-style compound.
  // This is a search goal, not a plain navigate — the extra clause matters.
  const navThenSearch = /\b(?:open|go to|navigate to)\b\s+\S+.{0,20}\band\s+search\b.{0,40}\bfor\b\s+(.+)$/i.exec(t);
  if (navThenSearch) {
    return { goalType: 'search', searchQuery: navThenSearch[1].trim() };
  }

  // Checkpoint 15: everything BELOW this point is where compound sentences
  // actually caused trouble — "Open wikipedia.org, search for OpenAI, open
  // the result, and tell me the page title" mentions a real domain AND ends
  // with a real "tell me" clause, but has two real dependent steps in
  // between that targetPhrase/domainMatch below would silently skip if
  // trusted on their own. Decided once, generically (goal-analysis.ts), not
  // per-pattern — but only gates the patterns actually prone to this,
  // not the search patterns above which already get it right.
  if (analyzeGoal(t).requiresPlan) {
    return { goalType: 'unclassified' };
  }

  // "open/select/click the <cheapest|top|...> <story|item|product|...>"
  // The descriptor group is optional-article-plus-anything, so "open the
  // result" (nothing but an article between the verb and the noun) matches
  // with an empty/article-only descriptor — wrongly treating a bare "the
  // result" as if it names an already-ranked, pickable target. That is
  // exactly what a PRIOR "search for X" clause in a compound sentence
  // produces (a result to open), not something this single-goal pattern
  // should claim on its own — require a real descriptive word (a hint like
  // "cheapest"/"top", or at least a non-article token) before matching.
  const targetPhrase = /\b(?:open|select|click|choose|pick)\b\s+(?:the\s+)?([a-z][\w\s-]{0,40}?)\s+(story|item|product|result|article|post|listing)\b/i.exec(
    t
  );
  const targetDescriptor = targetPhrase?.[1]?.trim().toLowerCase() ?? '';
  const hasRealDescriptor = targetDescriptor !== '' && !/^(the|a|an)$/.test(targetDescriptor);
  if (targetPhrase && hasRealDescriptor && TARGET_NOUN_RE.test(t)) {
    return { goalType: 'navigate_to_target', targetHint: pickHint(t) ?? 'top' };
  }

  // "open <domain> and tell me/extract/what is X"
  // Checkpoint 15: DOMAIN_RE's shape alone can't tell "amazon.com" from
  // "report.md" or "fixture.html" — a dotted token ending in a short
  // alpha suffix matches either. Gate it against the same file-extension
  // blocklist goal-analysis.ts uses, so a filename is never treated as a
  // navigable domain just because it happens to contain a dot.
  const domainMatchRaw = DOMAIN_RE.exec(t);
  const domainMatch = domainMatchRaw && !isFileLikeToken(domainMatchRaw[1]) ? domainMatchRaw : null;
  const extractClause = /\band\s+(?:tell me|extract|find out|report)\b\s*(.*)$/i.exec(t);
  if (domainMatch && extractClause) {
    const field = extractClause[1] || '';
    // Only "title" or "url/link/address" is unambiguous enough to answer
    // straight from the observation with zero planner call — anything else
    // ("what does this page say", "the main heading", "the price") needs an
    // actual read, which stays fully planner-driven.
    let extractionHint: GoalClassification['extractionHint'];
    if (/\b(page\s+)?title\b/i.test(field) && !/\b(url|link|address)\b/i.test(field)) {
      extractionHint = 'title';
    } else if (/\b(url|link|address)\b/i.test(field) && !/\btitle\b/i.test(field)) {
      extractionHint = 'url';
    }
    return { goalType: 'navigate_and_extract', namedDestination: domainMatch[1], extractionHint };
  }

  // Bare "open <domain>" with nothing else, or "open <domain>" plus only
  // trivial trailing text — mirrors bootstrap.ts's own strictness so this
  // never fires on a compound task bootstrap itself declined to handle.
  if (domainMatch) {
    const withoutDomain = t.replace(domainMatch[1], '').trim();
    const isBareOrSimpleOpen =
      t.trim() === domainMatch[1].trim() ||
      (/^(open|go to|navigate to|visit)\b/i.test(t) && !/\band\b/i.test(withoutDomain));
    if (isBareOrSimpleOpen) {
      return { goalType: 'navigate', namedDestination: domainMatch[1] };
    }
  }

  // "click <label>" with no site named — a plain interaction.
  if (/^click\b/i.test(t) && !domainMatch) {
    return { goalType: 'interact' };
  }

  return { goalType: 'unclassified' };
}

function pickHint(t: string): GoalClassification['targetHint'] | undefined {
  for (const { re, hint } of TARGET_HINT_RE) {
    if (re.test(t)) return hint;
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/* Evidence checks                                                     */
/* ------------------------------------------------------------------ */

/** Same registrable host, ignoring www./scheme/path — what "reached X.com" means. */
export function hostMatches(currentUrl: string, namedDestination: string): boolean {
  try {
    const target = new URL(normalizeUrl(namedDestination).url);
    const current = new URL(currentUrl);
    const norm = (h: string) => h.replace(/^www\./, '').toLowerCase();
    return norm(current.hostname) === norm(target.hostname);
  } catch {
    return false;
  }
}

/**
 * Does the current URL correspond to a committed target's destination?
 * Resolves the (possibly relative) href against the page it was captured
 * from, then compares host + pathname — query/hash/redirects (Nike appends
 * tracking params; sites redirect canonical -> localized paths) should not
 * make an otherwise-correct arrival look unsatisfied.
 */
export function reachedTarget(currentUrl: string, target: SelectedTarget): boolean {
  if (!target.destination) return false;
  try {
    const dest = new URL(target.destination, target.resolvedFrom);
    const current = new URL(currentUrl);
    const norm = (h: string) => h.replace(/^www\./, '').toLowerCase();
    if (norm(current.hostname) !== norm(dest.hostname)) return false;
    const trimSlash = (p: string) => p.replace(/\/+$/, '') || '/';
    return trimSlash(current.pathname) === trimSlash(dest.pathname);
  } catch {
    return false;
  }
}

/**
 * Pick a target deterministically from already-ranked ContentItems — no LLM
 * call needed. registry.ts already sorts priced items cheapest-first, so
 * "cheapest" and "top of the list" are BOTH just "the first item" once the
 * hint has already steered ranking upstream; 'priciest' is the one case that
 * needs a local re-sort here since the registry never produces that order.
 */
export function pickDeterministicTarget(
  contentItems: ContentItem[],
  targetHint: GoalClassification['targetHint'],
  pageUrl: string
): SelectedTarget | null {
  if (contentItems.length === 0) return null;

  // A price-comparison task ("cheapest"/"priciest") must not commit to
  // whatever happens to be contentItems[0] before any priced content has
  // even loaded — e.g. a site's homepage, reached before navigating to its
  // actual product listing, has no products yet but can still produce
  // content items (nav/category links). Wait for a later observation with
  // real price data rather than "commit" to a nav link as the answer.
  const priced = contentItems.filter((c) => c.numericPrice !== undefined);
  if ((targetHint === 'cheapest' || targetHint === 'priciest') && priced.length === 0) {
    return null;
  }

  let pool = contentItems;
  if (targetHint === 'cheapest' && priced.length > 0) {
    pool = [...priced].sort((a, b) => (a.numericPrice ?? 0) - (b.numericPrice ?? 0));
  } else if (targetHint === 'priciest' && priced.length > 0) {
    pool = [...priced].sort((a, b) => (b.numericPrice ?? 0) - (a.numericPrice ?? 0));
  }

  const item = pool[0];
  const actionId = item.primaryActionElementId || item.linkedElementId;
  if (!actionId && !item.href) return null; // nothing we could ever reach or click

  const reason =
    targetHint === 'cheapest'
      ? 'lowest price'
      : targetHint === 'priciest'
        ? 'highest price'
        : 'first in the ranked list';

  return {
    label: item.title || item.text || item.id,
    price: item.price,
    destination: item.href,
    elementId: actionId,
    actionRole: item.actionRole,
    reason,
    resolvedFrom: pageUrl,
  };
}

/**
 * Guard for the executor-owned href fallback (checkpoint 11 section 9): only
 * ever navigate automatically within the same origin the failure happened
 * on. A cross-origin href sneaking into a ContentItem is not expected from
 * the registry's own extraction, but this is the actual safety boundary, not
 * an incidental one — never remove it to "make the fallback more useful".
 */
export function isSameOrigin(href: string, pageUrl: string): boolean {
  try {
    return new URL(href, pageUrl).origin === new URL(pageUrl).origin;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Compact planner-facing rendering                                    */
/* ------------------------------------------------------------------ */

/** Short block for the planner prompt — evidence, not prose instructions. */
export function formatProgressForLLM(p: TaskProgress): string | null {
  if (p.goalType === 'unclassified') return null;
  const lines: string[] = [`goalType: ${p.goalType}`];
  if (p.namedDestination) lines.push(`namedDestination: ${p.namedDestination}`);
  if (p.searchQuery) lines.push(`searchQuery: ${p.searchQuery}`);
  if (p.selectedTarget) {
    // Includes the action id directly: once a target is committed, this
    // line alone is enough to act on it — the caller (context.ts) uses that
    // to safely shrink the separate, much larger contentItems list instead
    // of re-sending all ~12 candidates every step after the choice is made.
    lines.push(
      `selectedTarget: ${p.selectedTarget.label}${p.selectedTarget.price ? ` (${p.selectedTarget.price})` : ''}` +
        `${p.selectedTarget.elementId ? ` — action: ${p.selectedTarget.elementId}` : ''} — reason: ${p.selectedTarget.reason}`
    );
  }
  for (const m of p.milestones) {
    lines.push(`milestone "${m.description}": ${m.done ? 'done' : 'not done'}`);
  }
  return lines.join('\n  ');
}
