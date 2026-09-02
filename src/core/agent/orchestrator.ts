/**
 * Checkpoint 21 (thin orchestration layer), extended by Checkpoint 26
 * (bounded multi-step workflows), narrowly re-split by the CP26
 * architecture review — this file is now ONLY the public entry point /
 * precedence dispatcher:
 *
 *   raw user goal
 *     -> deterministic workflow recognition (orchestration/workflow-patterns.ts)
 *     -> selected known workflow, executed through the SAME functions the
 *        single-capability path already uses (detectCalendarIntent/
 *        detectGmailIntent/detectTasksIntent for parsing,
 *        runCalendarIntent/runGmailIntent/runTasksIntent for execution,
 *        the SAME PendingAction stores for any mutation)
 *     -> ExecutionResult (via task-manager.ts's attemptOrchestration)
 *
 * This is why no new confirmation mechanism is needed: a proposal an
 * orchestration step creates is indistinguishable, from the confirmation
 * gate's point of view, from one a single-capability request would have
 * created — "Create it."/"Send it."/"Mark it complete." already work
 * unchanged.
 *
 * No LLM anywhere in this file or in workflow-patterns.ts. Decomposition
 * is a fixed pattern match; "understanding" a dependent step (which
 * meeting is "last", what a found email's sender is) is plain data lookup
 * on already-fetched, normalized capability data (CalendarEvent/
 * MailMessage), never a fresh reasoning call. A step that mutates state
 * still only ever produces a *proposal* (proposalCreated) — creating/
 * sending/completing/deleting is reached exclusively through the
 * pre-existing confirmation-claim functions in task-manager.ts, unchanged
 * by this file.
 *
 * The 8 supported patterns (deliberately small and fixed — see each
 * function's own comment in workflow-patterns.ts; anything else falls
 * through to normal single-capability / browser routing, unchanged) plus
 * the two narrow "unsupported" safety nets below are tried in order by
 * tryOrchestration(), the sole export of this file.
 *
 * ---- Why this file only holds the dispatcher (CP26 architecture review) ----
 * Each pattern function in workflow-patterns.ts interleaves regex matching
 * with the capability calls that match implies (a captured clause
 * immediately drives which capability runs; dependency decisions like "was
 * the meeting found?" can only be made mid-execution). Splitting "parsing"
 * from "execution" into separate files would force every pattern's body to
 * be cut in half and reassembled through a data contract, for no boundary
 * benefit — so pattern recognition AND its matched execution were moved
 * together, as the single genuinely separable responsibility from this
 * file's own job of being the precedence entry point.
 */

import { detectCompoundQuery, detectConcepts } from '@/core/capabilities/shared/compound-classifier';
import { PATTERNS, buildUnsupportedCompoundResult, buildUnsupportedActionResult, UNSUPPORTED_ACTION_RE } from './orchestration/workflow-patterns';

export type { OrchestrationStepStatus, OrchestrationStepResult, OrchestrationResult } from './orchestration/workflow-types';
import type { OrchestrationResult } from './orchestration/workflow-types';

/**
 * Tries each fixed pattern in turn (cheap, synchronous regex reject before
 * any real work) and returns the first match's execution result. If none
 * matched but the text is still clearly a compound multi-capability
 * personal query, or an imperative request naming both a real capability
 * and a known-unsupported action, returns the explicit unsupported result
 * rather than null — this is the one case where tryOrchestration's
 * non-null return isn't one of the supported patterns, and it
 * deliberately never reaches single-capability or browser routing.
 * Returns null only when nothing in this small supported grammar, and no
 * recognized unsupported-compound shape, applies at all — callers fall
 * through to the existing single-capability/browser routing, completely
 * unchanged from before this checkpoint.
 */
export async function tryOrchestration(goal: string, signal: AbortSignal | undefined, sessionId: string): Promise<OrchestrationResult | null> {
  const t = goal.trim();
  for (const pattern of PATTERNS) {
    const result = await pattern(t, signal, sessionId);
    if (result) return result;
  }
  const compound = detectCompoundQuery(t);
  if (compound) return buildUnsupportedCompoundResult(compound.concepts);

  const unsupportedMatch = UNSUPPORTED_ACTION_RE.exec(t);
  if (unsupportedMatch) {
    const concepts = detectConcepts(t);
    if (concepts.length > 0) return buildUnsupportedActionResult(concepts[0], unsupportedMatch[0]);
  }
  return null;
}
