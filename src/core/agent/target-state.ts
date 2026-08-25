/**
 * Checkpoint 16 §8-13 — CommittedTarget: replaces the shallow, single
 * shallow-merged `priorFacts` object Checkpoints 14-15 used for
 * cross-subgoal state. That object had no ownership (any subgoal's fields
 * silently overwrote any other's) and no lifetime (a stale URL from an
 * unrelated early subgoal could survive to the end of a long plan).
 *
 * Deliberately small: a flat list of explicitly-owned targets plus a
 * regex-based reference resolver. Not a knowledge graph — there is no
 * cross-task persistence, no relationship modeling beyond "which subgoal
 * produced this and when."
 */

export type TargetKind = 'product' | 'article' | 'story' | 'repo' | 'page' | 'generic';

export interface CommittedTarget {
  id: string;
  kind: TargetKind;
  label?: string;
  url?: string;
  price?: string;
  sourceSubgoalId: string;
  committedAt: number;
  evidence: string;
}

/** Per-task state — a flat, ordered history. The LAST entry is "active" by default; kind-specific references may reach further back. Never global, never persisted past one task. */
export class TargetStateStore {
  private targets: CommittedTarget[] = [];

  commit(target: Omit<CommittedTarget, 'committedAt'>): CommittedTarget {
    const full: CommittedTarget = { ...target, committedAt: Date.now() };
    this.targets.push(full);
    return full;
  }

  /** Most recently committed target, regardless of kind — what a bare "it"/"that" resolves to. */
  active(): CommittedTarget | undefined {
    return this.targets[this.targets.length - 1];
  }

  /** Most recent target of a specific kind — what "the article"/"the repository"/"the product" resolves to, searching backward past an unrelated intervening commit. */
  mostRecentOfKind(kind: TargetKind): CommittedTarget | undefined {
    for (let i = this.targets.length - 1; i >= 0; i--) {
      if (this.targets[i].kind === kind) return this.targets[i];
    }
    return undefined;
  }

  bySourceSubgoal(subgoalId: string): CommittedTarget | undefined {
    return [...this.targets].reverse().find((t) => t.sourceSubgoalId === subgoalId);
  }

  all(): readonly CommittedTarget[] {
    return this.targets;
  }
}

/* ------------------------------------------------------------------ */
/* Reference resolution (§11-13)                                       */
/* ------------------------------------------------------------------ */

// Kind-specific reference phrases checked FIRST (more precise); generic
// pronouns checked last (resolve to whatever is most recently active,
// regardless of kind). Order matters — "the article" must not fall through
// to the generic "the" + noun bucket before its own kind-specific check runs.
const KIND_REFERENCES: { re: RegExp; kind: TargetKind }[] = [
  { re: /\bthe\s+(?:article|story)\b/i, kind: 'article' },
  { re: /\bthe\s+(?:repo(?:sitory)?)\b/i, kind: 'repo' },
  { re: /\bthe\s+product\b/i, kind: 'product' },
];
const GENERIC_REFERENCE_RE = /\b(it'?s?|that one|that|the (?:first|top|best|cheapest)\s+result|the result|the selected item)\b/i;
// "the same page" / "this page" is a request to stay on the CURRENT page,
// not a reference to a committed SELECTION target at all — handled by the
// executor's existing direct-extract-from-current-page logic (Checkpoint
// 14 §12), not by this resolver. Recognized here only so callers can tell
// "not a target reference" apart from "a target reference we couldn't resolve."
const SAME_PAGE_RE = /\b(the same page|this page)\b/i;

/**
 * Checkpoint 16 §12 — the single source of truth for "does this text contain
 * a reference phrase at all," shared with goal-analysis.ts's dependency
 * detection so the two modules can never disagree about what counts as a
 * referent. Union of every phrase this file's own resolver recognizes
 * (kind-specific + generic + same-page) — deliberately NOT re-derived from
 * the individual regexes above (their capture/ordering semantics differ),
 * just their vocabulary.
 */
export const REFERENCE_PHRASE_RE =
  /\b(it'?s?|that one|that|the (?:first|top|best|cheapest)\s+result|the result|the selected item|the article|the story|the repo(?:sitory)?|the product|the same page|this page)\b/i;

export interface ReferenceResolution {
  reference: string | null;
  resolved: boolean;
  target?: CommittedTarget;
  isSamePageReference: boolean;
  reason: string;
}

/**
 * Deterministic only — no LLM call. If a reference phrase is present but no
 * compatible committed target exists, resolved is false and target is
 * omitted: callers must NOT guess (§13's "REFERENCE_UNRESOLVED", not a
 * fallback to whatever's most recent regardless of fit).
 */
export function resolveReference(description: string, store: TargetStateStore): ReferenceResolution {
  if (SAME_PAGE_RE.test(description)) {
    return { reference: 'the same page', resolved: false, isSamePageReference: true, reason: 'References the current page, not a committed selection target.' };
  }

  for (const { re, kind } of KIND_REFERENCES) {
    const m = re.exec(description);
    if (m) {
      const target = store.mostRecentOfKind(kind);
      if (target) {
        return { reference: m[0], resolved: true, target, isSamePageReference: false, reason: `Resolved to the most recent committed ${kind} target.` };
      }
      return { reference: m[0], resolved: false, isSamePageReference: false, reason: `No committed target of kind "${kind}" exists — REFERENCE_UNRESOLVED.` };
    }
  }

  const generic = GENERIC_REFERENCE_RE.exec(description);
  if (generic) {
    const target = store.active();
    if (target) {
      return { reference: generic[0], resolved: true, target, isSamePageReference: false, reason: 'Resolved to the most recently committed target.' };
    }
    return { reference: generic[0], resolved: false, isSamePageReference: false, reason: 'No committed target exists at all — REFERENCE_UNRESOLVED.' };
  }

  return { reference: null, resolved: false, isSamePageReference: false, reason: 'No reference phrase found in this subgoal.' };
}
