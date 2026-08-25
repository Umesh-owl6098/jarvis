import { PageObservation } from './observation';
import type { TaskProgress } from './agent/goal-state';

/**
 * ContextManager: Manages conversation context and token efficiency.
 *
 * Responsibilities:
 * - Keep task goal and recent actions
 * - Remove old/irrelevant history
 * - Maintain recent observations
 * - Calculate approximate token usage
 * - Decide what to send to LLM
 */

export interface ContextMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  tokens?: number; // Approximate token count
}

export interface TaskContext {
  goal: string;
  startTime: number;
  observations: PageObservation[];
  actions: string[]; // Log of what agent did
  messages: ContextMessage[];
  totalTokensSent: number;
  lastStateFingerprint?: string; // For detecting when page changes
  repeatedActionCount: number; // Track repeated identical ineffective actions
  plannerCalls: number;
  correctionRetries: number; // Schema-invalid-response retries, a subset of plannerCalls
}

export interface BudgetStatus {
  totalTokens: number;
  plannerCalls: number;
  correctionRetries: number;
  overWarn: boolean;
  overHard: boolean;
}

export class ContextManager {
  private context: TaskContext;
  /**
   * Fingerprint of the last observation whose FULL elements/contentItems
   * were actually sent to the planner. Used to detect "this is the exact
   * same page I already fully described" — which only happens after a
   * failed action changed nothing — so the second copy can be compressed.
   */
  private lastFullySentFingerprint: string | null = null;

  constructor(goal: string) {
    this.context = {
      goal,
      startTime: Date.now(),
      observations: [],
      actions: [],
      messages: [],
      totalTokensSent: 0,
      repeatedActionCount: 0,
      plannerCalls: 0,
      correctionRetries: 0,
    };
  }

  /**
   * Check if page state has changed since last observation.
   */
  hasPageChanged(newFingerprint: string): boolean {
    if (!this.context.lastStateFingerprint) {
      this.context.lastStateFingerprint = newFingerprint;
      return false; // First observation, no change to detect
    }

    const changed = this.context.lastStateFingerprint !== newFingerprint;
    if (changed) {
      this.context.lastStateFingerprint = newFingerprint;
      this.context.repeatedActionCount = 0; // Reset counter on page change
    }
    return changed;
  }

  /**
   * Track repeated actions without page change.
   */
  trackRepeatedAction(): number {
    this.context.repeatedActionCount++;
    return this.context.repeatedActionCount;
  }

  /**
   * Reset repeated action counter.
   */
  resetRepeatedActionCounter(): void {
    this.context.repeatedActionCount = 0;
  }

  /**
   * Add a new observation to context.
   * Keep only the last 5 observations to save memory.
   */
  addObservation(obs: PageObservation): void {
    this.context.observations.push(obs);

    // Keep only recent observations
    if (this.context.observations.length > 5) {
      this.context.observations.shift();
    }
  }

  /**
   * Log an action the agent took.
   * Keep only recent actions (last 10).
   */
  logAction(action: string, result?: string): void {
    this.context.actions.push(`${action}${result ? ` → ${result}` : ''}`);

    if (this.context.actions.length > 10) {
      this.context.actions.shift();
    }
  }

  /**
   * Get the compact context to send to LLM.
   * This is what gets included in the prompt.
   *
   * @param progress Checkpoint 11's TaskProgress, when the goal was
   *   classified. Used only to shrink contentItems once a target is already
   *   committed — the raw observation.contentItems (what evaluateProgress()
   *   reasons from) is never touched, only what gets rendered here.
   */
  getContextForLLM(progress?: TaskProgress): string {
    const latestObs = this.context.observations[this.context.observations.length - 1];

    // §5: if this is the EXACT page state already sent in full last call —
    // only possible after a failed/ineffective action left nothing changed
    // — don't pay for the same elements/contentItems arrays twice. The
    // failure block (built separately in planner.ts) already carries what
    // actually matters for a retry: the failure itself and any alternative.
    const unchanged =
      !!latestObs &&
      this.lastFullySentFingerprint !== null &&
      latestObs.stateFingerprint === this.lastFullySentFingerprint;

    if (latestObs && !unchanged) {
      this.lastFullySentFingerprint = latestObs.stateFingerprint;
    }

    // §6/§8: once a target is committed, the planner's only remaining job
    // is to act on it (or use the alternative the failure block already
    // supplies) — the other ~11 ranked candidates it already compared once
    // are dead weight on every subsequent step.
    const contentItemsForLLM = (() => {
      if (!latestObs?.contentItems?.length) return [];
      if (!progress?.selectedTarget) return latestObs.contentItems;
      const match = latestObs.contentItems.filter((c) => c.title === progress.selectedTarget!.label);
      return match.length > 0 ? match : latestObs.contentItems.slice(0, 3);
    })();

    return JSON.stringify({
      task: this.context.goal,
      currentPage: latestObs
        ? unchanged
          ? {
              // Compact form: enough to re-orient without re-describing a
              // page the planner already has a full description of.
              url: latestObs.url,
              title: latestObs.title,
              unchanged: true,
              fingerprint: latestObs.stateFingerprint,
              elementsAvailable: latestObs.interactiveElements.length,
              ...(contentItemsForLLM.length ? { contentItemsAvailable: contentItemsForLLM.length } : {}),
              ...(latestObs.blockers?.length ? { blockers: latestObs.blockers } : {}),
            }
          : {
              url: latestObs.url,
              title: latestObs.title,
              textPreview: latestObs.visibleTextSummary,
              // Compact per-element record: empty fields are omitted entirely, since
              // they would otherwise be paid for on every element of every step.
              elements: latestObs.interactiveElements.map(e => {
                const rec: Record<string, unknown> = { id: e.id, role: e.role };
                if (e.name) rec.name = e.name.substring(0, 60);
                if (e.placeholder) rec.placeholder = e.placeholder.substring(0, 40);
                if (e.type) rec.type = e.type;
                if (e.disabled) rec.disabled = true;
                if (e.checked !== undefined) rec.checked = e.checked;
                if (e.selected) rec.selected = e.selected.substring(0, 40);
                return rec;
              }),
              ...(latestObs.elementsTruncated
                ? { elementsShown: latestObs.interactiveElements.length, elementsTotal: latestObs.elementsTotalFound }
                : {}),
              // Structured content: relationships already resolved (title+price+link
              // mapped together), so the planner can compare/select without
              // re-discovering the relationship by clicking around.
              ...(contentItemsForLLM.length
                ? {
                    contentItems: contentItemsForLLM.map(c => {
                      const rec: Record<string, unknown> = { id: c.id, type: c.type };
                      if (c.title) rec.title = c.title.substring(0, 80);
                      if (c.price) rec.price = c.price;
                      if (c.numericPrice !== undefined) rec.numericPrice = c.numericPrice;
                      if (c.text && !c.price) rec.text = c.text.substring(0, 100);
                      const actionId = c.primaryActionElementId || c.linkedElementId;
                      if (actionId) rec.action = actionId;
                      // href/actionRole are deliberately NOT sent here: exposing a
                      // ready-made URL on every step tempted the planner into
                      // navigating straight to it instead of comparing prices and
                      // clicking first (measured: it skipped price comparison
                      // entirely and jumped to an arbitrary item). The direct-href
                      // fallback (planner rule 18) only ever needs to exist once a
                      // click has actually failed — see contentItemContextFor() in
                      // executor.ts, which reads href/actionRole from the raw
                      // observation object, not from this compact block.
                      return rec;
                    }),
                    ...(latestObs.contentItemsTruncated || contentItemsForLLM.length < (latestObs.contentItems?.length ?? 0)
                      ? { contentItemsShown: contentItemsForLLM.length, contentItemsTotal: latestObs.contentItemsTotalFound }
                      : {}),
                  }
                : {}),
              ...(latestObs.blockers?.length ? { blockers: latestObs.blockers } : {}),
              ...(latestObs.openTabs && latestObs.openTabs > 1 ? { openTabs: latestObs.openTabs } : {}),
            }
        : null,
      recentActions: this.context.actions.slice(-3), // §4: rolling window, was 5 — TaskProgress carries milestone-level state now
      failureCount: this.countFailures(),
    });
  }

  /**
   * Estimate token count for a string.
   * Rough approximation: 1 token ≈ 4 characters
   */
  estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  /**
   * Track tokens sent to LLM.
   */
  recordTokenUsage(inputTokens: number, outputTokens: number): void {
    this.context.totalTokensSent += inputTokens + outputTokens;
  }

  /**
   * Get current token usage.
   */
  getTokenUsage(): number {
    return this.context.totalTokensSent;
  }

  /** One real API call was made — `wasRetry` for a schema-correction retry, a subset of the total. */
  recordPlannerCall(wasRetry: boolean = false): void {
    this.context.plannerCalls++;
    if (wasRetry) this.context.correctionRetries++;
  }

  /**
   * §13: task-level token accounting. Defaults are deliberately generous —
   * the highest real task measured so far (Nike, checkpoint 11) was ~21k
   * tokens; a hard stop at 150k is a last-resort catch for a genuine
   * runaway that somehow evaded every other guard, not a tuning knob.
   */
  getBudgetStatus(warnThreshold = 40000, hardThreshold = 150000): BudgetStatus {
    const totalTokens = this.context.totalTokensSent;
    return {
      totalTokens,
      plannerCalls: this.context.plannerCalls,
      correctionRetries: this.context.correctionRetries,
      overWarn: totalTokens >= warnThreshold,
      overHard: totalTokens >= hardThreshold,
    };
  }

  /**
   * Check if we should stop (too many failures or actions).
   */
  shouldStop(maxSteps: number = 20, maxFailures: number = 3): boolean {
    return this.context.actions.length >= maxSteps || this.countFailures() >= maxFailures;
  }

  private countFailures(): number {
    return this.context.actions.filter(a => a.includes('failed') || a.includes('error')).length;
  }

  /**
   * Get full context state (for debugging).
   */
  getState(): TaskContext {
    return { ...this.context };
  }
}
