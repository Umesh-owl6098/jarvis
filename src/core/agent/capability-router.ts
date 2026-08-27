import { classifyGoal } from './goal-state';
import { toAbsoluteUrl } from '@/core/browser/url';
import type { ReadSource } from '@/core/capabilities/read';

/**
 * CapabilityRouter: picks the cheapest reliable way to satisfy a task,
 * before any browser is launched.
 *
 * Deterministic only — no LLM call to choose a capability (Checkpoint 13
 * §5). Reuses classifyGoal's existing domain extraction rather than a
 * second, divergent URL-parsing implementation. Conservative by design:
 * anything that isn't a clear, resolvable, read-only request stays on the
 * existing browser path unchanged — reliability over cleverness.
 */

// Checkpoint 17/18/20: 'gmail'/'calendar'/'tasks' exist on this union for
// type-consistency with ExecutionResult.capability.selected, but
// routeCapability() itself never returns any of them — all three are
// intercepted in task-manager.ts's runTask() BEFORE decomposeTask/
// routeCapability even run (see detectGmailIntent/detectCalendarIntent/
// detectTasksIntent). All are single-shot operations, not multi-step
// browser subgoal chains, so none needs TaskPlan decomposition or this
// router's own browser-vs-read heuristics.
export type Capability = 'read' | 'browser' | 'gmail' | 'calendar' | 'tasks';

export interface CapabilityDecision {
  selectedCapability: Capability;
  routingReason: string;
  fallbackCapability?: Capability;
  /** Only set when selectedCapability === 'read'. */
  readUrl?: string;
  readSource?: ReadSource;
  readMeta?: { owner?: string; repo?: string; wikipediaTitle?: string; searchQuery?: string };
}

// Interaction verbs always force the browser path — a read capability
// cannot click, type, log in, or submit anything, and must never be asked
// to try.
const INTERACT_RE =
  /\b(click|type|login|log in|sign in|sign up|submit|add to cart|fill|upload|download|interact|compose|buy|purchase|checkout|pay|add\b.*\bto\b)\b/i;

// Read-flavored phrasing — deliberately narrow, per §5's examples.
const READ_VERB_RE =
  /\b(read|summarize|tell me|find information|find out|top story|extract text|what does|what is|report on)\b/i;

// Hacker News names a well-known, real, official public API (see read.ts's
// readHackerNewsTopStory) — checked before the generic namedDestination path
// so "the top Hacker News story" routes to that API, not a generic page
// fetch. Checked as three independent terms (not one ordered phrase) since
// "hacker news" can land before or after "top ... story" in natural phrasing.
const HN_MENTION_RE = /\bhacker\s*news\b/i;
const HN_TOP_STORY_TERMS_RE = /\b(top|first|latest)\b/i;
const STORY_RE = /\bstor(y|ies)\b/i;

// "GitHub repository owner/repo" / "github.com/owner/repo" — both name a
// concrete repo without necessarily forming a dotted domain classifyGoal's
// DOMAIN_RE would catch, so this is checked directly.
const GITHUB_REPO_SHORTHAND_RE = /\bgithub\b.{0,25}?\b([\w.-]+)\/([\w.-]+)\b/i;

// "the <name> GitHub repository" — names a PROJECT, not an owner/repo pair.
// Generic for any project name (not specific to any one repo) — resolved by
// searching GitHub's own public index (read.ts's readGitHubRepoSearch),
// never guessed by the planner. Checked only when the shorthand above
// didn't already match. Three alternatives, tried in order: after a
// find/search/identify/locate verb; after a bare "the"; or the whole clause
// starts with the name — each captures ONLY the project name itself, never
// a leading verb (a naive single greedy-from-start pattern previously
// captured "Find the React" instead of "React" — verified against GitHub's
// search API returning an unrelated repo before this fix).
const GITHUB_REPO_BY_NAME_RE =
  /\b(?:find|search for|identify|locate)\s+(?:the\s+)?([\w][\w\s-]{0,40}?)\s+github\s+repo(?:sitory)?\b|\bthe\s+([\w][\w\s-]{0,40}?)\s+github\s+repo(?:sitory)?\b|^([\w][\w\s-]{0,40}?)\s+github\s+repo(?:sitory)?\b/i;

// "<subject> on Wikipedia" / "Wikipedia for <subject>" — Wikipedia's URL
// scheme (/wiki/<Title>) and its official summary REST API are stable public
// knowledge, so this is a deterministic transform, not a guess-and-hope. If
// the guess is wrong, the summary API returns a non-2xx, which readWikipediaSummary
// treats as a failure — the caller falls back to the browser, so a wrong
// guess fails closed, not silently.
const WIKI_SUBJECT_RE =
  /\b(?:about|on)\s+(.+?)\s+(?:on|in)\s+wikipedia\b|\bwikipedia\b.{0,20}\bfor\s+(.+)$/i;

function resolveGitHubReadme(url: string): { owner: string; repo: string } | null {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.replace(/^www\./, '') !== 'github.com') return null;
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts.length !== 2) return null;
    return { owner: parts[0], repo: parts[1] };
  } catch {
    return null;
  }
}

export function routeCapability(task: string): CapabilityDecision {
  const t = task.trim();

  if (INTERACT_RE.test(t)) {
    return {
      selectedCapability: 'browser',
      routingReason: 'Task language names an interaction (click/type/submit/etc.) — the read capability cannot interact.',
    };
  }

  if (HN_MENTION_RE.test(t) && HN_TOP_STORY_TERMS_RE.test(t) && STORY_RE.test(t)) {
    return {
      selectedCapability: 'read',
      routingReason: "Task asks for Hacker News' top story — routed to HN's own official public API.",
      fallbackCapability: 'browser',
      readSource: 'hn-api',
    };
  }

  const githubShorthand = GITHUB_REPO_SHORTHAND_RE.exec(t);
  if (githubShorthand) {
    return {
      selectedCapability: 'read',
      routingReason: 'Task names a public GitHub repository and asks to read it — routed to the GitHub README API.',
      fallbackCapability: 'browser',
      readSource: 'github-readme',
      readMeta: { owner: githubShorthand[1], repo: githubShorthand[2] },
    };
  }

  const githubByName = GITHUB_REPO_BY_NAME_RE.exec(t);
  if (githubByName) {
    return {
      selectedCapability: 'read',
      routingReason: 'Task names a GitHub repository by project name (not owner/repo) — resolved via GitHub\'s own search API, not guessed.',
      fallbackCapability: 'browser',
      readSource: 'github-search',
      readMeta: { searchQuery: (githubByName[1] || githubByName[2] || githubByName[3] || '').trim() },
    };
  }

  // Wikipedia subject lookup takes priority — it resolves to a specific
  // article, not a bare domain, so it must run before the generic
  // namedDestination path below.
  const wikiMatch = WIKI_SUBJECT_RE.exec(t);
  if (wikiMatch) {
    const subject = (wikiMatch[1] || wikiMatch[2] || '').trim();
    if (subject) {
      return {
        selectedCapability: 'read',
        routingReason: "Task asks for information on a named Wikipedia subject — routed to Wikipedia's own official summary API.",
        fallbackCapability: 'browser',
        readSource: 'wikipedia-api',
        readMeta: { wikipediaTitle: subject },
      };
    }
  }

  const classification = classifyGoal(t);
  const namedDestination = classification.namedDestination;

  const looksLikeRead = READ_VERB_RE.test(t) || classification.goalType === 'navigate_and_extract';

  if (!namedDestination) {
    return {
      selectedCapability: 'browser',
      routingReason: 'No concrete, resolvable destination found for a deterministic read.',
    };
  }
  if (!looksLikeRead) {
    return {
      selectedCapability: 'browser',
      routingReason: 'Destination is known, but task language does not clearly indicate a pure read.',
    };
  }

  let url: string;
  try {
    url = toAbsoluteUrl(namedDestination);
  } catch {
    return {
      selectedCapability: 'browser',
      routingReason: 'Named destination did not resolve to a navigable URL.',
    };
  }

  const githubReadme = resolveGitHubReadme(url);
  if (githubReadme) {
    return {
      selectedCapability: 'read',
      routingReason: 'Task names a public GitHub repository and asks to read it — routed to the GitHub README API.',
      fallbackCapability: 'browser',
      readUrl: url,
      readSource: 'github-readme',
      readMeta: githubReadme,
    };
  }

  return {
    selectedCapability: 'read',
    routingReason: 'Task requires retrieval only; no interaction requested; destination resolved deterministically.',
    fallbackCapability: 'browser',
    readUrl: url,
    readSource: 'jina',
  };
}
