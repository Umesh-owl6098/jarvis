/**
 * Checkpoint 14 — TaskPlan/Subgoal model.
 *
 * Deliberately minimal, layered on top of the EXISTING single-goal
 * classifyGoal()/TaskProgress machinery (Checkpoint 11) rather than
 * replacing it. Decomposition only ever runs when classifyGoal() has
 * nothing to offer for the whole task (goalType === 'unclassified') — any
 * task the existing deterministic classifier already understands keeps
 * running through the unmodified single AgentExecutor.execute() path.
 *
 * The decomposer is generic clause-splitting + verb classification, reusing
 * the same vocabulary already used elsewhere (capability-router.ts,
 * goal-state.ts) — it does not special-case any site or task by name. Any
 * task-specific behavior (e.g. Hacker News having a real API) lives entirely
 * in CapabilityRouter/read.ts, invoked identically per subgoal as it already
 * is per whole-task — this file has no knowledge of specific sites.
 */

export type SubgoalType = 'navigate' | 'search' | 'select' | 'interact' | 'extract' | 'read';
export type SubgoalStatus = 'pending' | 'active' | 'completed' | 'blocked' | 'failed';

export interface Subgoal {
  id: string;
  description: string;
  type: SubgoalType;
  status: SubgoalStatus;
  /** Non-required subgoals: failure is disclosed but does not fail the task (§18). */
  optional?: boolean;
  targetHint?: 'cheapest' | 'priciest' | 'top' | 'first';
  /** Human-readable evidence once completed — never "the planner said so" (§8). */
  evidence?: string;
  capability?: 'read' | 'browser';
  /**
   * Checkpoint 15: set by deterministic plan repair when a read-capability
   * failure should not be retried via read again — same description/type
   * as before repair (a real oscillation check would otherwise flag an
   * unchanged subgoal), but a materially different execution: read is
   * skipped entirely and routing goes straight to browser.
   */
  forceCapability?: 'browser';
}

export interface TaskPlan {
  originalGoal: string;
  subgoals: Subgoal[];
  replans: number;
}

export function currentSubgoal(plan: TaskPlan): Subgoal | undefined {
  return plan.subgoals.find((s) => s.status === 'pending' || s.status === 'active');
}
export function completedSubgoals(plan: TaskPlan): Subgoal[] {
  return plan.subgoals.filter((s) => s.status === 'completed');
}
export function failedSubgoals(plan: TaskPlan): Subgoal[] {
  return plan.subgoals.filter((s) => s.status === 'failed' || s.status === 'blocked');
}

/* ------------------------------------------------------------------ */
/* Decomposition                                                       */
/* ------------------------------------------------------------------ */

export const MAX_SUBGOALS = 8;

// Reject the WHOLE plan if any clause requests one of these — §29.
const UNSAFE_RE =
  /\b(buy|purchase|checkout|check out|add to cart|pay|log ?in|sign ?in|sign ?up|delete|remove permanently|send (?:a )?(?:message|email)|subscribe|unsubscribe|follow\b|unfollow|post\b|comment\b|donate|transfer money|wire\b)\b/i;

const SEARCH_RE = /\b(search|find)\b.{0,30}\bfor\b/i;
// "find" is deliberately included here too ("find the top story") — but only
// fires in combination with a target hint (cheapest/top/first/...) below, so
// it never shadows SEARCH_RE's "find ... for" case (checked first) or a
// plain "find the react github repository" (no hint present).
const SELECT_RE = /\b(select|choose|pick|identify|find)\b/i;
const HINT_RE: { re: RegExp; hint: Subgoal['targetHint'] }[] = [
  { re: /\b(cheapest|least costly|least expensive|lowest[- ]price[d]?)\b/i, hint: 'cheapest' },
  { re: /\b(priciest|most expensive|highest[- ]price[d]?)\b/i, hint: 'priciest' },
  { re: /\b(top|first|latest|newest)\b/i, hint: 'top' },
];
const NAV_VERB_RE = /\b(open|go to|navigate to|visit|reach)\b/i;
// A capitalized multi-word or single proper-noun-ish phrase, or a dotted
// domain — "Hacker News", "Wikipedia", "GitHub", "example.com". Deliberately
// broad-but-safe: only used to decide WHICH subgoal type a clause is, not to
// resolve an actual URL (CapabilityRouter/classifyGoal do that later, on the
// resolved subgoal text, exactly as they already do for whole tasks).
const NAMED_PLACE_RE = /\b((?:[A-Z][a-z0-9]+(?:\s+[A-Z][a-z0-9]+)*)|(?:[a-z0-9-]+\.[a-z]{2,}\S*))\b/;
// Deliberately anchored to the START of the clause: "open it" / "click the
// result" is a continuation-interaction; "tell me what it is for" merely
// contains the word "it" without being one, and must not match here.
// Allows up to two modifier words between "the" and the noun ("the
// offscreen link", "the covered button") — a plain "the (?:noun)" match
// alone missed real phrasing like that.
const PRONOUN_CONTINUATION_RE =
  /^\s*(?:open|click|select|visit|go to)\s+(it|the (?:\w+\s+){0,2}(?:story|result|item|article|repo(?:sitory)?|page|link|button|first result))\b/i;
const EXTRACT_RE = /\b(tell me|extract|what is|what does|report|says?)\b/i;
const READ_RE = /\bread\b/i;
// Same pattern CapabilityRouter uses to resolve a GitHub repo by project
// name via search rather than a guessed owner/repo — checked here too so
// decomposition classifies it as 'read' up front instead of a generic
// 'navigate' the browser planner would then have to guess a URL for.
const GITHUB_REPO_BY_NAME_RE = /\bgithub\b.{0,10}\brepo(?:sitory)?\b/i;

interface ClauseClassification {
  type: SubgoalType;
  targetHint?: Subgoal['targetHint'];
}

function pickHint(clause: string): Subgoal['targetHint'] | undefined {
  for (const { re, hint } of HINT_RE) if (re.test(clause)) return hint;
  return undefined;
}

/** Classify one clause; null means "not confidently classifiable" — caller must reject the whole plan. */
function classifyClause(clause: string, isFirstClause: boolean): ClauseClassification | null {
  const t = clause.trim();
  if (!t) return null;

  if (SEARCH_RE.test(t)) return { type: 'search' };

  if (GITHUB_REPO_BY_NAME_RE.test(t)) return { type: 'read' };

  if (SELECT_RE.test(t) && pickHint(t)) return { type: 'select', targetHint: pickHint(t) };

  // A continuation clause ("open it", "click the result") with no newly
  // named destination is an interaction on the prior subgoal's target, not
  // a fresh navigation.
  if (PRONOUN_CONTINUATION_RE.test(t) && !NAMED_PLACE_RE.test(t.replace(PRONOUN_CONTINUATION_RE, ''))) {
    return { type: 'interact' };
  }

  if (NAV_VERB_RE.test(t) && NAMED_PLACE_RE.test(t)) return { type: 'navigate' };

  if (EXTRACT_RE.test(t)) return { type: 'extract' };

  if (READ_RE.test(t)) return { type: 'read' };

  // The very first clause is often a bare destination with no verb at all
  // ("Hacker News, ...") — treat a named place with nothing else matched as
  // an implicit navigate only when it's first; elsewhere that's too loose.
  if (isFirstClause && NAMED_PLACE_RE.test(t)) return { type: 'navigate' };

  return null;
}

/** Exported for goal-analysis.ts — same clause boundaries, shared not duplicated. */
export function splitClauses(task: string): string[] {
  const cleaned = task.trim().replace(/[.?!]+$/, '');
  return cleaned
    .split(/\s*,\s*(?:and\s+)?|\s+and then\s+|\s+then\s+|\s+and\s+(?=(?:open|click|select|choose|pick|find|search|read|tell|extract|report|identify|reach|go|navigate|verify)\b)/i)
    .map((c) => c.trim())
    .filter(Boolean);
}

/**
 * Attempt deterministic decomposition. Returns null when the task doesn't
 * confidently split into a sensible multi-step plan — the caller falls back
 * to the existing single-shot path, never forcing a bad decomposition.
 */
export function decomposeTask(task: string): { subgoals: Subgoal[] } | { rejected: string } | null {
  if (UNSAFE_RE.test(task)) {
    return { rejected: 'Task requests a side-effecting action (purchase/login/send/delete/...) that this checkpoint does not support.' };
  }

  const clauses = splitClauses(task);
  if (clauses.length < 2) return null; // not actually multi-step
  if (clauses.length > MAX_SUBGOALS) {
    return { rejected: `Decomposition produced ${clauses.length} steps, exceeding the configured limit of ${MAX_SUBGOALS}.` };
  }

  const subgoals: Subgoal[] = [];
  const seenDescriptions = new Set<string>();
  for (let i = 0; i < clauses.length; i++) {
    const classification = classifyClause(clauses[i], i === 0);
    if (!classification) return null; // can't confidently classify — bail out entirely

    const norm = clauses[i].toLowerCase();
    if (seenDescriptions.has(norm)) continue; // drop exact duplicate clause, not a new subgoal
    seenDescriptions.add(norm);

    subgoals.push({
      id: `sg${subgoals.length + 1}`,
      description: clauses[i],
      type: classification.type,
      status: 'pending',
      targetHint: classification.targetHint,
    });
  }

  if (subgoals.length < 2) return null;

  // A plain "open X, click/interact with Y" pair — exactly the shape the
  // EXISTING AgentExecutor already runs as ONE unified execution (this is
  // precisely what the Checkpoint 10 robustness fixtures exercise: a single
  // navigate-then-interact task with its own internal recovery/retry/href-
  // fallback logic spanning both steps). Splitting it into two SEPARATE
  // subgoal executions would replace that proven, unified recovery context
  // with subgoal-level replanning instead — a real behavior change for
  // tasks that already worked well, not a genuine multi-step improvement.
  // Only reject this exact minimal shape; a 'select'/'search'/'read' step
  // anywhere in the plan is a real dependency chain and still decomposes.
  if (subgoals.length === 2 && subgoals[0].type === 'navigate' && subgoals[1].type === 'interact') {
    return null;
  }

  return { subgoals };
}

/* ------------------------------------------------------------------ */
/* Validation (§26) — defense in depth, independent of decomposeTask's own checks */
/* ------------------------------------------------------------------ */

const SUPPORTED_TYPES: SubgoalType[] = ['navigate', 'search', 'select', 'interact', 'extract', 'read'];

export function validatePlan(subgoals: Subgoal[]): { ok: true } | { ok: false; reason: string } {
  if (subgoals.length === 0) return { ok: false, reason: 'Empty plan' };
  if (subgoals.length > MAX_SUBGOALS) return { ok: false, reason: `Plan exceeds the maximum of ${MAX_SUBGOALS} subgoals` };

  const ids = new Set<string>();
  for (const sg of subgoals) {
    if (!SUPPORTED_TYPES.includes(sg.type)) return { ok: false, reason: `Unsupported subgoal type "${sg.type}"` };
    if (!sg.id || ids.has(sg.id)) return { ok: false, reason: `Duplicate or missing subgoal id "${sg.id}"` };
    ids.add(sg.id);
    if (UNSAFE_RE.test(sg.description)) return { ok: false, reason: `Subgoal "${sg.id}" requests an unsupported side-effecting action` };
  }

  for (let i = 1; i < subgoals.length; i++) {
    if (subgoals[i].description.trim().toLowerCase() === subgoals[i - 1].description.trim().toLowerCase()) {
      return { ok: false, reason: `Subgoal "${subgoals[i].id}" duplicates the previous subgoal — likely a loop` };
    }
  }

  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* Compact planner-facing rendering (§7, §21) — same spirit as goal-state.ts's formatProgressForLLM */
/* ------------------------------------------------------------------ */

export function formatPlanForLLM(plan: TaskPlan): string {
  const lines: string[] = [`overallGoal: ${plan.originalGoal}`];
  const cur = currentSubgoal(plan);
  if (cur) lines.push(`currentSubgoal: ${cur.id} (${cur.type}) — ${cur.description}`);
  const done = completedSubgoals(plan);
  if (done.length) {
    lines.push(`completedSubgoals: ${done.map((s) => `${s.id}${s.evidence ? ` (${s.evidence})` : ''}`).join('; ')}`);
  }
  const remaining = plan.subgoals.filter((s) => s.status === 'pending' && s !== cur);
  if (remaining.length) lines.push(`remainingSubgoals: ${remaining.map((s) => s.id).join(', ')}`);
  return lines.join('\n  ');
}
