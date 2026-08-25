import { BrowserController } from '@/core/browser/controller';
import { Planner, PlannerAction } from './planner';
import { ContextManager } from '@/core/context';
import { SkillRegistry } from '@/skills/registry';
import { ObservationBuilder, PageObservation } from '@/core/observation';
import { EventCollector, AgentEvent } from './events';
import { nanoid } from 'nanoid';
import { planBootstrapNavigation } from './bootstrap';
import { BrowserError } from '@/core/browser/errors';
import type { NavigationEvidence } from '@/core/browser/navigation-evidence';
import {
  classifyGoal,
  pickDeterministicTarget,
  reachedTarget,
  hostMatches,
  isSameOrigin,
  type TaskProgress,
  type TaskOutcome,
  type SelectedTarget,
} from './goal-state';

export interface ExecutionResult {
  taskId: string;
  goal: string;
  status: 'success' | 'failed' | 'stopped';
  /**
   * Finer-grained than `status`: distinguishes a fully evidence-backed
   * completion from a partial result, an external block, or a system
   * failure. Optional and additive — `status` keeps its existing meaning
   * for any caller that doesn't read this field.
   */
  outcome?: TaskOutcome;
  result: string;
  steps: number;
  tokensUsed: number;
  actions: string[];
  events: AgentEvent[];
  error?: string;
  /**
   * Checkpoint 13: which capability actually produced this result, and why.
   * Optional and additive — absent means the pre-Checkpoint-13 browser-only
   * path ran with no router involved (e.g. direct AgentExecutor construction
   * in scripts/tests that bypass task-manager.ts).
   */
  capability?: {
    selected: 'read' | 'browser';
    reason: string;
    fallbackCapability?: 'browser';
    readAttempted: boolean;
    readFailure?: string;
    browserFallbackUsed: boolean;
  };
  /**
   * Checkpoint 14: the committed target (if any), for cross-subgoal result
   * passing — lets a subsequent subgoal consume the exact resolved
   * URL/label deterministically instead of rediscovering it from scratch.
   * Optional and additive; unrelated to existing single-goal callers.
   */
  selectedTarget?: SelectedTarget;
  /**
   * Checkpoint 15: EXACT planner-call accounting, straight from
   * ContextManager's own counter (Checkpoint 12) — replaces Checkpoint 14's
   * subgoal-runner approximation (Math.max(1, steps)), which could over- or
   * under-count whenever a step needed a schema-retry or a subgoal
   * completed deterministically with real steps but no planner call.
   */
  plannerCalls?: number;
  correctionRetries?: number;
}

/**
 * AgentExecutor: Runs the main agent loop.
 *
 * Flow:
 * 1. OBSERVE: Get current page state
 * 2. PLAN: Use LLM to decide what to do
 * 3. VALIDATE: Check action is valid
 * 4. ACT: Execute skill
 * 5. EVALUATE: Did it work? Continue or stop?
 */
export class AgentExecutor {
  private taskId: string = '';
  private stepCount: number = 0;
  private lastAction: string = '';
  /** Fingerprint of the previous attempt, updated on success AND failure. */
  private lastActionKey: string = '';
  /** Structured context about the previous failure, fed to the next plan. */
  private lastFailure: {
    action: string;
    code: string;
    error: string;
    url: string;
    urlChanged: boolean;
    domChanged: boolean;
    attempts: number;
    /** Populated when the failed action targeted a known ContentItem. */
    targetTitle?: string;
    targetPrice?: string;
    /** A read-only navigation the planner may try instead of re-clicking. */
    alternativeHref?: string;
    /** Another action id on the same content item (e.g. a secondary link). */
    alternateActionElementId?: string;
  } | null = null;
  private lastObsFingerprint: string = '';
  private repeatedActionCount: number = 0;
  /**
   * How many times each (action, failure code) signature has failed, across
   * the WHOLE task — not reset by navigation. The consecutive-repeat guard
   * below only catches the same action failing twice in a row at an
   * UNCHANGED url/fingerprint; an agent that wanders to a different page and
   * back (observed: home -> sale -> product -> sale) presents as a "fresh"
   * state each time and never trips it, while retrying the exact same
   * permanently-occluded element. This catches that case independently.
   */
  private failedSignatureCounts: Map<string, number> = new Map();
  private maxCrossNavigationRepeats = 1;
  /**
   * How many times each URL has been observed this task. Catches a DIFFERENT
   * pattern than the guards above: an agent that alternates between two
   * pages with every action *succeeding* (click story -> navigate back to
   * listing -> click story -> navigate back...) makes no progress but never
   * fails and never repeats an identical action at an identical URL, so
   * neither the consecutive-repeat guard nor the failure-signature guard
   * sees anything wrong. Measured: this happened with zero errors for 10
   * full steps before the step cap silently ended it.
   */
  private urlVisitCounts: Map<string, number> = new Map();
  /** Two visits to the same URL is normal (try a result, come back, try another). A third is not. */
  private maxUrlVisits = 2;
  /**
   * URL as of the previous loop iteration. A "visit" only counts when the
   * URL differs from this — i.e. we actually arrived here again after being
   * somewhere else. Checkpoint 12 found the bug this guards against: without
   * it, a normal single-page task (navigate once, then take several actions
   * — e.g. a failed extraction, a corrected retry, then finish — never
   * leaving the page) was miscounted as 3+ "visits" to the same URL and
   * falsely tripped as a cycle, even though the URL never actually changed
   * and no navigation ever occurred between those steps.
   */
  private previousUrlKey: string | null = null;
  /**
   * Trip after the second identical ineffective attempt, not the third.
   * The planner now receives structured failure context and is told not to
   * repeat, so another round of the same action is not new information — it is
   * ~2,300 tokens and ~15s spent confirming what we already know.
   */
  private maxRepeatedActions: number = 1;
  private eventCollector: EventCollector = new EventCollector();
  /**
   * Deterministic goal/progress tracking (checkpoint 11). Null for the whole
   * task when classifyGoal() has no confident read on the task shape — in
   * that case nothing below changes: the planner decides everything exactly
   * as it did before this checkpoint.
   */
  private progress: TaskProgress | null = null;
  /**
   * Checkpoint 16: the most recent navigation's structured evidence — set
   * right after any navigation skill call (bootstrap or in-loop), consulted
   * by evaluateProgress() so a 404/5xx/browserError can never be read as
   * "reached" just because the observation shows the requested URL/host.
   */
  private lastNavigationEvidence: NavigationEvidence | null = null;

  constructor(
    private browser: BrowserController,
    private planner: Planner,
    private context: ContextManager,
    private skills: SkillRegistry,
    private maxSteps: number = 20,
    /** §13: soft warning only — logged, never changes behavior. */
    private tokenWarnThreshold: number = 40000,
    /** §13: last-resort stop. Generous on purpose — see ContextManager.getBudgetStatus. */
    private tokenHardThreshold: number = 150000,
    /**
     * Checkpoint 14: when false, leaves the browser session open on exit so
     * a subsequent subgoal can continue on the same page instead of
     * relaunching. Every existing caller keeps the default (true) — no
     * single-goal task is affected. Only the subgoal runner passes false,
     * and only for a non-final subgoal in the same TaskPlan.
     */
    private closeBrowserOnFinish: boolean = true,
  ) {}

  getEventCollector(): EventCollector {
    return this.eventCollector;
  }

  /**
   * Execute a task to completion.
   * @param task The task to execute
   * @param signal Optional AbortSignal for cancellation
   * @param taskId Optional task ID to use (useful for tracking/cancellation)
   */
  async execute(task: string, signal?: AbortSignal, taskId?: string): Promise<ExecutionResult> {
    console.log(`[integrity] executor.task=${JSON.stringify(task)} len=${task.length}`);
    this.taskId = taskId || nanoid();
    this.stepCount = 0;
    this.eventCollector.clear();
    this.eventCollector.setTaskId(this.taskId);

    console.log(`\n🤖 Starting JARVIS execution (${this.taskId})`);
    console.log(`📋 Task: ${task}\n`);

    const classification = classifyGoal(task);
    console.log(`   🧭 goalType: ${classification.goalType}${classification.targetHint ? ` (${classification.targetHint})` : ''}`);
    this.progress = {
      goal: task,
      goalType: classification.goalType,
      namedDestination: classification.namedDestination,
      searchQuery: classification.searchQuery,
      targetHint: classification.targetHint,
      extractionHint: classification.extractionHint,
      milestones: [],
      searchDone: false,
      hrefFallbackAttempted: false,
    };

    this.eventCollector.emit('task.started', { task, taskId: this.taskId });

    try {
      // Check for cancellation
      signal?.throwIfAborted();

      // Initialize browser
      await this.browser.initialize();
      this.eventCollector.emit('browser.initialized', { taskId: this.taskId });

      // Deterministic bootstrap: an explicitly named single destination on a
      // blank page needs no model call, and must keep working when the router
      // is rate limited. Everything after this is planned normally.
      const bootstrap = planBootstrapNavigation(task, await this.browser.getURL());
      if (bootstrap) {
        console.log(`🚀 BOOTSTRAP: ${bootstrap.url} (${bootstrap.reason})`);
        this.eventCollector.emit(
          'agent.action.started',
          { action: 'use_skill', skillId: 'navigation', bootstrap: true, url: bootstrap.url },
          1
        );
        const navSkill = this.skills.getSkill('navigation');
        const navResult = navSkill
          ? await navSkill.execute({ url: bootstrap.url })
          : { success: false, error: 'navigation skill unavailable' };
        if (navResult.result) this.lastNavigationEvidence = navResult.result as NavigationEvidence;

        if (navResult.success) {
          this.context.logAction(`navigate ${bootstrap.url}`, 'success');
          this.lastAction = `use_skill:navigation:${bootstrap.url}`;
          this.eventCollector.emit(
            'agent.action.completed',
            { action: 'use_skill', skillId: 'navigation', bootstrap: true },
            1
          );
        } else {
          // Not fatal — fall through and let the planner try.
          console.log(`   ⚠️  Bootstrap navigation failed: ${navResult.error}`);
          this.eventCollector.emit(
            'agent.action.failed',
            { action: 'use_skill', skillId: 'navigation', bootstrap: true, error: navResult.error },
            1
          );
        }
      }

      while (this.stepCount < this.maxSteps) {
        // Check for cancellation at loop start
        signal?.throwIfAborted();
        console.log(`\n--- Step ${this.stepCount + 1}/${this.maxSteps} ---`);

        // 1. OBSERVE
        this.eventCollector.emit('agent.observing', {}, this.stepCount + 1);
        const observation = await this.observe(task);
        this.eventCollector.emit('browser.state.changed', {
          url: observation.url,
          title: observation.title,
        });
        this.context.addObservation(observation);

        // Checkpoint 11: deterministic goal completion. Checked BEFORE any
        // guard or planner call — if the browser has already, evidenceably,
        // reached what the task asked for, there is nothing left to plan.
        // This is what stops JARVIS reaching the right page and then
        // wandering away from it again: completion no longer depends on an
        // LLM call remembering that it already got there.
        const satisfied = this.evaluateProgress(observation);
        if (satisfied) {
          this.eventCollector.emit('agent.completed', { result: satisfied, deterministic: true });
          return this.success(satisfied, 'completed');
        }

        // Cycle detection: returning to a URL already ARRIVED AT several
        // times this task, regardless of whether the actions in between
        // succeeded. Only counts when the URL actually changed since the
        // last step — staying on one page across several actions (a failed
        // attempt, a corrected retry, then finish) is not a "visit" each
        // time, it's one visit with normal work happening on it. Query
        // strings/fragments intentionally collapsed — "the listing" and
        // "the listing?sort=x" are the same place for this purpose.
        const urlKey = observation.url.split(/[?#]/)[0];
        const arrivedFresh = urlKey !== this.previousUrlKey;
        const visits = arrivedFresh ? (this.urlVisitCounts.get(urlKey) ?? 0) + 1 : this.urlVisitCounts.get(urlKey) ?? 1;
        if (arrivedFresh) this.urlVisitCounts.set(urlKey, visits);
        this.previousUrlKey = urlKey;
        if (visits > this.maxUrlVisits) {
          this.eventCollector.emit('agent.failed', { reason: 'unproductive navigation cycle' });
          return this.fail(
            `Returned to ${observation.url} ${visits} times without completing the request — the agent is ` +
              `cycling between pages rather than making progress. Stopping rather than continuing to alternate.`
          );
        }

        // §13: task-level token budget. The warn tier is a log line only —
        // it never changes behavior. The hard tier is a last-resort stop for
        // a genuine runaway that evaded every other guard above; the default
        // is generous enough that no task measured so far comes within 7x of it.
        const budget = this.context.getBudgetStatus(this.tokenWarnThreshold, this.tokenHardThreshold);
        if (budget.overWarn && !budget.overHard) {
          console.log(`   ⚠️  Token budget warning: ${budget.totalTokens} tokens across ${budget.plannerCalls} planner calls`);
        }
        if (budget.overHard) {
          this.eventCollector.emit('agent.failed', { reason: 'token budget exceeded' });
          return this.fail(
            `TOKEN_BUDGET_EXCEEDED: ${budget.totalTokens} tokens across ${budget.plannerCalls} planner calls, ` +
              `exceeding the configured limit of ${this.tokenHardThreshold}. Stopping rather than continuing to spend.`
          );
        }

        // Repeat means: the same action, at the same URL, with the page in the
        // same state. All three must hold — the old check compared a value to
        // itself and so tripped on page-fingerprint equality alone.
        if (this.lastFailure) {
          this.lastFailure.domChanged =
            observation.stateFingerprint !== this.lastObsFingerprint;
        }
        const actionKey = this.getActionKey(observation.url, this.lastAction);
        const sameAction = this.lastActionKey !== '' && actionKey === this.lastActionKey;
        if (sameAction && observation.stateFingerprint === this.lastObsFingerprint) {
          this.repeatedActionCount++;
          console.log(`⚠️  Repeated action detected (${this.repeatedActionCount}/${this.maxRepeatedActions})`);

          if (this.repeatedActionCount > this.maxRepeatedActions) {
            // Say what was actually achieved and why it stalled. "Repeated
            // ineffective action" alone tells the operator nothing about the
            // page they are looking at.
            const target = this.lastFailure?.targetTitle
              ? ` The target was "${this.lastFailure.targetTitle}"${this.lastFailure.targetPrice ? ` (${this.lastFailure.targetPrice})` : ''}.`
              : '';
            const detail = this.lastFailure
              ? `The page did not respond to ${this.lastFailure.action} (${this.lastFailure.code}).${target}`
              : 'The page state stopped changing in response to further actions.';
            const shown = observation.interactiveElements.length;
            const total = observation.elementsTotalFound ?? shown;
            const truncated =
              observation.elementsTruncated
                ? ` Only ${shown} of ${total} interactive elements were visible to the planner, so the needed control may not have been among them.`
                : '';
            this.eventCollector.emit('agent.failed', { reason: 'repeated action' });
            return this.fail(
              `Reached ${observation.url}` +
                (observation.title ? ` (${observation.title})` : '') +
                `, but could not complete the request. ${detail}${truncated}`
            );
          }
        } else {
          this.repeatedActionCount = 0;
        }

        // 2. PLAN
        this.eventCollector.emit('agent.planning', { url: observation.url }, this.stepCount + 1);
        const action = await this.plan(observation);

        // Check for cancellation after planning
        signal?.throwIfAborted();

        // 3. VALIDATE
        if (!this.isValidAction(action)) {
          console.log('❌ Invalid action from planner');
          this.context.logAction('planner returned invalid action', 'failed');
          continue;
        }

        // 4. ACT
        this.eventCollector.emit('agent.action.started', {
          action: action.action,
          skillId: action.action === 'use_skill' ? (action as any).skillId : undefined,
        }, this.stepCount + 1);

        const result = await this.act(action);
        if (action.action === 'use_skill' && (action as any).skillId === 'navigation' && result.data) {
          this.lastNavigationEvidence = result.data as NavigationEvidence;
        }

        if (!result.success) {
          const urlAfter = await this.browser.getURL().catch(() => observation.url);
          const codeMatch = /^\[([A-Z_]+)\]/.exec(String(result.error ?? ''));

          // Remember exactly what was tried, so an identical retry is detected
          // on the NEXT iteration rather than after several wasted steps.
          this.lastAction = this.actionFingerprint(action);
          this.lastActionKey = this.getActionKey(observation.url, this.lastAction);
          this.lastFailure = {
            action: this.lastAction,
            code: codeMatch ? codeMatch[1] : 'UNKNOWN',
            error: String(result.error ?? '').slice(0, 180),
            url: urlAfter,
            urlChanged: urlAfter !== observation.url,
            domChanged: false, // filled in at the next observation
            attempts: (this.lastFailure?.action === this.actionFingerprint(action)
              ? this.lastFailure.attempts
              : 0) + 1,
            ...this.contentItemContextFor(observation, action),
          };

          this.eventCollector.emit('agent.action.failed', {
            action: action.action,
            error: result.error,
          }, this.stepCount + 1);
          this.context.logAction(`${action.action} failed`, result.error);

          // Executor-owned href fallback (checkpoint 11 section 9): a normal
          // click failed, but the failure resolved to the ALREADY-COMMITTED
          // target (not just any content item), that target exposes a
          // same-origin navigational href, and no fallback has been tried
          // for it yet. Checkpoint 10 only ever surfaced this as information
          // for the planner to maybe act on — measured result: it sometimes
          // did, sometimes didn't. Doing it directly here makes the recovery
          // deterministic instead of probabilistic, without weakening safety:
          // this fires only for a link-role href on the SAME target the
          // executor already selected, on the SAME origin as the failure.
          if (
            this.progress?.selectedTarget &&
            !this.progress.hrefFallbackAttempted &&
            this.lastFailure.alternativeHref &&
            this.lastFailure.targetTitle === this.progress.selectedTarget.label &&
            isSameOrigin(this.lastFailure.alternativeHref, observation.url)
          ) {
            this.progress.hrefFallbackAttempted = true;
            // ContentItem.href is the raw DOM attribute — often relative
            // ("t/product-123", "test-fixture-deal-detail.html") — and must
            // be resolved against the page it was captured from before use.
            const resolvedHref = new URL(this.lastFailure.alternativeHref, observation.url).toString();
            const navSkill = this.skills.getSkill('navigation');
            const navResult = navSkill
              ? await navSkill.execute({ url: resolvedHref })
              : { success: false, error: 'navigation skill unavailable' };
            if (navResult.success) {
              console.log(`   🔗 Executor-owned href fallback -> ${resolvedHref}`);
              this.context.logAction('navigation (executor href fallback)', 'success');
              this.eventCollector.emit('agent.recovery', { reason: 'executor href fallback to committed target' });
              this.lastAction = 'use_skill:navigation:href-fallback';
              this.lastActionKey = this.getActionKey(observation.url, this.lastAction);
              this.lastFailure = null;
              this.stepCount++;
              continue;
            }
          }

          // Cross-navigation repeat: the SAME action + failure code happening
          // a second time anywhere in the task, regardless of what pages were
          // visited in between. Measured cause: after an occlusion failure,
          // the planner navigated away, wandered, came back to the identical
          // page, and hit the identical occlusion again — each time looking
          // like a "fresh" state to the consecutive-repeat check above, so it
          // never tripped and the task ran out the full step budget instead.
          // Prefer the ContentItem title as the identity key: element ids are
          // reassigned on every snapshot (registry.ts clears and restamps
          // e1..eN fresh each time), so the SAME product can legitimately
          // arrive as "e49" one observation and "e53" the next — keying on
          // the raw id alone would treat that as two different targets and
          // never catch the repeat. Title is stable across re-observation of
          // the same underlying content.
          const sigKey = this.lastFailure.targetTitle
            ? `content-item::${this.lastFailure.targetTitle}::${this.lastFailure.code}`
            : `${this.lastFailure.action}::${this.lastFailure.code}`;
          const sigCount = (this.failedSignatureCounts.get(sigKey) ?? 0) + 1;
          this.failedSignatureCounts.set(sigKey, sigCount);
          if (sigCount > this.maxCrossNavigationRepeats) {
            // Deliberately does NOT claim whether the href fallback was tried
            // — the executor doesn't track that, and a wrong guess here would
            // be worse than saying nothing (observed: the planner sometimes
            // DOES follow the href, lands on the item page, then clicks its
            // way back to the listing instead of finishing there).
            const target = this.lastFailure.targetTitle
              ? ` The target was "${this.lastFailure.targetTitle}"${this.lastFailure.targetPrice ? ` (${this.lastFailure.targetPrice})` : ''}.`
              : '';
            this.eventCollector.emit('agent.failed', { reason: 'repeated action across navigation' });
            return this.fail(
              `Reached ${this.lastFailure.url}, but ${this.lastFailure.action} failed the same way ` +
                `(${this.lastFailure.code}) on two separate attempts, including after navigating away and back.` +
                `${target} Stopping rather than continuing to retry the same blocked action.`
            );
          }

          // A failed action must not send us back into observe() on a dead
          // session — that is what turned one navigation failure into a
          // secondary page.title() crash. Classify first.
          if (!this.browser.isAlive()) {
            const recovered = await this.browser.recoverPage();
            if (!recovered) {
              const live = this.browser.livenessError();
              const reason = live?.message ?? 'The browser session ended';
              this.eventCollector.emit('agent.failed', { reason, code: live?.code ?? 'BROWSER_CLOSED' });
              return this.fail(`Browser session ended: ${reason}`);
            }
            console.log('   ♻️  Page was closed; recovered a fresh page in the same context');
            this.context.logAction('browser page recovered', 'success');
            this.eventCollector.emit('agent.recovery', { reason: 'page recovered after action failure' });
          }

          this.stepCount++;
          continue;
        }

        this.eventCollector.emit('agent.action.completed', {
          action: action.action,
        }, this.stepCount + 1);
        const actionLabel = action.action === 'use_skill' ? `use_skill:${(action as any).skillId}` : action.action;
        const dataSummary = this.summarizeActionData(result.data);
        this.context.logAction(dataSummary ? `${actionLabel} (${dataSummary})` : actionLabel, 'success');

        // Search milestone: known deterministically from the skill call
        // itself, not guessed from the resulting page — gates target
        // selection for search_and_open so a pre-search homepage's content
        // is never mistaken for a search result.
        if (this.progress && action.action === 'use_skill' && (action as any).skillId === 'search') {
          this.progress.searchDone = true;
        }

        // Track action for repetition detection
        this.lastAction = this.actionFingerprint(action);
        this.lastActionKey = this.getActionKey(observation.url, this.lastAction);
        this.lastFailure = null; // progress made — clear failure context
        this.lastObsFingerprint = observation.stateFingerprint;

        // 5. EVALUATE
        if (action.action === 'finish') {
          this.eventCollector.emit('agent.completed', { result: action.result });
          return this.success(action.result || 'Task completed', this.classifyFinishOutcome(observation));
        }

        if (action.action === 'fail') {
          this.eventCollector.emit('agent.failed', { reason: action.reason });
          const blocked = /captcha|blocked|bot.?detection|human.?verif/i.test(action.reason ?? '');
          return this.fail(
            action.reason || 'Agent failed',
            undefined,
            blocked ? 'blocked' : this.progress?.selectedTarget ? 'partial' : 'failed'
          );
        }

        this.stepCount++;
      }

      this.eventCollector.emit('agent.failed', { reason: 'Max steps exceeded' });
      return this.fail('Max steps exceeded');
    } catch (error: any) {
      // Handle abort (cancellation)
      if (error.name === 'AbortError') {
        const result: ExecutionResult = {
          taskId: this.taskId,
          goal: this.context.getState().goal,
          status: 'stopped',
          result: 'Task was cancelled by user',
          steps: this.stepCount,
          tokensUsed: this.context.getTokenUsage(),
          actions: this.context.getState().actions,
          events: this.eventCollector.getEvents(),
          plannerCalls: this.context.getBudgetStatus().plannerCalls,
          correctionRetries: this.context.getBudgetStatus().correctionRetries,
        };
        console.log(`\n⏹️  TASK CANCELLED\n`);
        return result;
      }

      // If we already reached a real page, say so — "failed" alone would hide
      // that the requested site is open and only the remaining work stopped.
      let progress: string | undefined;
      try {
        const url = await this.browser.getURL();
        if (url && url !== 'about:blank') {
          const title = await this.browser.getTitle().catch(() => '');
          progress = `Navigated to ${url}${title ? ` (${title})` : ''}, but could not continue:`;
        }
      } catch {
        // best effort only
      }

      this.eventCollector.emit('agent.failed', { reason: error.message, progress });
      return this.fail(error.message, progress);
    } finally {
      if (this.closeBrowserOnFinish) {
        await this.browser.close();
      }
    }
  }

  private async observe(task: string): Promise<PageObservation> {
    console.log('👀 OBSERVE: Analyzing page state');
    const obs = await ObservationBuilder.buildFromBrowser(
      this.browser,
      task,
      this.context.getState().actions[this.context.getState().actions.length - 1],
    );
    console.log(`   URL: ${obs.url}`);
    console.log(`   Title: ${obs.title}`);
    console.log(`   Elements: ${obs.interactiveElements.length}`);
    return obs;
  }

  private async plan(observation: PageObservation): Promise<PlannerAction> {
    console.log('🧠 PLAN: Asking LLM what to do');
    if (this.lastFailure) {
      console.log(
        `   ↳ carrying failure context: ${this.lastFailure.code} on ${this.lastFailure.action} (try ${this.lastFailure.attempts})`
      );
    }
    try {
      const action = await this.planner.plan(observation, this.lastFailure, this.progress ?? undefined);
      console.log(`   Action: ${action.action}`);
      return action;
    } catch (error: any) {
      throw error;
    }
  }

  private isValidAction(action: PlannerAction): boolean {
    if (action.action === 'use_skill') {
      return !!this.skills.getSkill(action.skillId);
    }
    return action.action === 'finish' || action.action === 'fail';
  }

  private async act(action: PlannerAction): Promise<{ success: boolean; error?: string; data?: unknown }> {
    console.log(`⚡ ACT: Executing action`);

    try {
      if (action.action === 'use_skill') {
        const skill = this.skills.getSkill(action.skillId);
        if (!skill) {
          return { success: false, error: `Skill not found: ${action.skillId}` };
        }

        const result = await skill.execute(action.input);
        if (result.success) {
          console.log(`   ✅ ${action.skillId} succeeded`);
          return { success: true, data: result.result };
        } else {
          console.log(`   ❌ ${action.skillId} failed: ${result.error}`);
          // Checkpoint 16: a failed skill call can still carry real
          // evidence (NavigationSkill attaches NavigationEvidence even on
          // a browserError) — forwarding it lets evaluateProgress and
          // plan repair reason from what actually happened, not just the
          // bare error string.
          return { success: false, error: result.error, data: result.result };
        }
      }

      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Short, generic gist of a skill's output for the action-history log —
   * keyed on shape (title/url/text fields), never on which skill or site
   * produced it. Without this, every successful use_skill call logged as the
   * identical "use_skill → success" regardless of whether it navigated,
   * extracted, or clicked — the planner had no way to tell from history that
   * it already had the content it needed, and would repeat the call.
   */
  private summarizeActionData(data: unknown): string {
    if (!data || typeof data !== 'object') return '';
    const d = data as Record<string, unknown>;
    const squeeze = (s: string, max: number) => {
      const flat = s.replace(/\s+/g, ' ').trim();
      return flat.length > max ? `${flat.slice(0, max)}…` : flat;
    };
    if (typeof d.title === 'string') return `title="${squeeze(d.title, 60)}"`;
    if (typeof d.text === 'string') return `text="${squeeze(d.text, 100)}"`;
    if (typeof d.url === 'string') return `url=${d.url}`;
    return '';
  }

  private success(result: string, outcome: TaskOutcome = 'completed'): ExecutionResult {
    console.log(`\n✅ TASK COMPLETED (${outcome})\n${result}`);
    return {
      taskId: this.taskId,
      goal: this.context.getState().goal,
      status: 'success',
      outcome,
      result,
      steps: this.stepCount,
      tokensUsed: this.context.getTokenUsage(),
      actions: this.context.getState().actions,
      events: this.eventCollector.getEvents(),
      selectedTarget: this.progress?.selectedTarget,
      plannerCalls: this.context.getBudgetStatus().plannerCalls,
      correctionRetries: this.context.getBudgetStatus().correctionRetries,
    };
  }

  private fail(error: string, progress?: string, outcome?: TaskOutcome): ExecutionResult {
    const detail = progress ? `${progress} ${error}` : error;
    const resolvedOutcome = outcome ?? this.inferStallOutcome();
    console.log(`\n❌ TASK FAILED (${resolvedOutcome})\n${detail}`);
    error = detail;
    return {
      taskId: this.taskId,
      goal: this.context.getState().goal,
      status: 'failed',
      outcome: resolvedOutcome,
      result: error,
      steps: this.stepCount,
      tokensUsed: this.context.getTokenUsage(),
      actions: this.context.getState().actions,
      events: this.eventCollector.getEvents(),
      error,
      selectedTarget: this.progress?.selectedTarget,
      plannerCalls: this.context.getBudgetStatus().plannerCalls,
      correctionRetries: this.context.getBudgetStatus().correctionRetries,
    };
  }

  /**
   * Best-effort classification for a failure with no explicit outcome given.
   * Evidence, not vibes: an interactability/blocker code from the actual
   * last failure means an external condition (BLOCKED); a committed target
   * means real work happened even though it didn't finish (PARTIAL); no
   * evidence of either means the run genuinely produced nothing (FAILED).
   */
  private inferStallOutcome(): TaskOutcome {
    const blockedCodes = new Set([
      'ELEMENT_OCCLUDED',
      'ELEMENT_NOT_VISIBLE',
      'ELEMENT_MOVING',
      'ELEMENT_DETACHED',
      'CAPTCHA_DETECTED',
      'NAVIGATION_BLOCKED',
      'POPUP_BLOCKING',
    ]);
    if (this.lastFailure && blockedCodes.has(this.lastFailure.code)) return 'blocked';
    if (this.progress?.selectedTarget) return 'partial';
    return 'failed';
  }

  /**
   * Evidence-based completion check for classified goals. Returns a result
   * string the moment observed browser state proves the goal is satisfied,
   * or null to mean "keep going, planner decides". Also opportunistically
   * commits a selectedTarget as soon as content items are available — this
   * happens here (not only on success) so the planner's next prompt already
   * shows what was picked, rather than re-deriving it itself.
   */
  /**
   * Checkpoint 16 §3/§6: "the observation shows the right URL" was never
   * enough on its own — a 404/5xx page has the right URL too. Only refuses
   * completion when the LAST navigation's evidence is actually ABOUT the
   * current page (same final URL, ignoring query/hash) and shows a real
   * error; evidence from a page we've since navigated away from, or no
   * evidence at all (e.g. this page was reached by a click, not a
   * navigation skill call), never blocks completion — that would be
   * inventing distrust the browser gave no reason for.
   */
  private navigationEvidenceBlocksCompletion(observation: PageObservation): boolean {
    const ev = this.lastNavigationEvidence;
    if (!ev) return false;
    const trimQuery = (u: string) => u.split(/[?#]/)[0];
    if (trimQuery(ev.finalUrl) !== trimQuery(observation.url)) return false;
    return ev.errorPageDetected;
  }

  private evaluateProgress(observation: PageObservation): string | null {
    const p = this.progress;
    if (!p) return null;

    if (p.goalType === 'navigate' && p.namedDestination) {
      if (hostMatches(observation.url, p.namedDestination) && !this.navigationEvidenceBlocksCompletion(observation)) {
        return `Opened ${observation.url}${observation.title ? ` (${observation.title})` : ''}.`;
      }
      return null;
    }

    // §11/§12: a plain "tell me the title" or "tell me the url" request
    // doesn't need a planner call at all once we've actually arrived — both
    // fields are already sitting in the observation. Anything less literal
    // ("what does this page say", "the price", "the heading") is NOT covered
    // here on purpose — that needs an actual read, which stays with the
    // planner (classifyGoal only sets extractionHint for the two literal cases).
    if (p.goalType === 'navigate_and_extract' && p.namedDestination && p.extractionHint) {
      if (!hostMatches(observation.url, p.namedDestination)) return null;
      if (this.navigationEvidenceBlocksCompletion(observation)) return null;
      if (p.extractionHint === 'title' && observation.title) {
        return `The page title of ${p.namedDestination} is '${observation.title}'.`;
      }
      if (p.extractionHint === 'url') {
        return `The current URL is ${observation.url}.`;
      }
      return null;
    }

    const targetGoal = p.goalType === 'navigate_to_target' || (p.goalType === 'search_and_open' && p.searchDone);
    if (targetGoal) {
      if (!p.selectedTarget && observation.contentItems.length > 0) {
        const target = pickDeterministicTarget(observation.contentItems, p.targetHint, observation.url);
        if (target) {
          p.selectedTarget = target;
          console.log(`   🎯 Target committed: ${target.label}${target.price ? ` (${target.price})` : ''} — ${target.reason}`);
        }
      }
      if (p.selectedTarget && reachedTarget(observation.url, p.selectedTarget) && !this.navigationEvidenceBlocksCompletion(observation)) {
        return (
          `Reached "${p.selectedTarget.label}"${p.selectedTarget.price ? ` (${p.selectedTarget.price})` : ''} ` +
          `at ${observation.url} — selected because it was the ${p.selectedTarget.reason}.`
        );
      }
    }

    return null;
  }

  /**
   * When the PLANNER decides to finish (as opposed to the deterministic
   * evaluateProgress() path above), still check the same evidence before
   * calling it fully 'completed' — a classified goal whose milestones are
   * not actually satisfied yet is a 'partial' result even if the planner
   * is confident. An unclassified goal has no such evidence to check
   * against, so it's trusted exactly as before this checkpoint.
   */
  private classifyFinishOutcome(observation: PageObservation): TaskOutcome {
    const p = this.progress;
    if (!p || p.goalType === 'unclassified') return 'completed';

    if (p.goalType === 'navigate' && p.namedDestination) {
      return hostMatches(observation.url, p.namedDestination) ? 'completed' : 'partial';
    }
    if ((p.goalType === 'navigate_to_target' || p.goalType === 'search_and_open') && p.selectedTarget) {
      return reachedTarget(observation.url, p.selectedTarget) ? 'completed' : 'partial';
    }
    // navigate_and_extract / search / interact: no deterministic check built
    // for these goal types (see classifyGoal's docs) — trust the planner.
    return 'completed';
  }

  private formatAction(action: PlannerAction): string {
    if (action.action === 'use_skill') {
      const skillAction = action as any;
      return `use_skill:${skillAction.skillId}:${JSON.stringify(skillAction.input)}`;
    }
    return action.action;
  }

  /**
   * Fingerprint of "what we just tried, and where".
   *
   * The previous implementation compared this expression to itself, so the
   * action was never actually part of the repeat check — only the page
   * fingerprint was. It also only recorded successful actions, so a failing
   * action repeated forever without ever updating the key.
   */
  private getActionKey(url: string, action: string): string {
    return `${action}@${url}`;
  }

  /** Compact, comparable description of an action including its target. */
  private actionFingerprint(action: any): string {
    if (!action || typeof action !== 'object') return 'unknown';
    if (action.action === 'finish') return 'finish';
    if (action.action === 'fail') return 'fail';
    const input = action.input ?? {};
    const target =
      input.elementId ?? input.url ?? input.query ?? input.selector ?? input.type ?? '';
    const verb = input.action ?? '';
    return `use_skill:${action.skillId}:${verb}:${target}`;
  }

  /**
   * If the failed action clicked a ContentItem's action element, surface that
   * item's identity plus a safe alternative — so the next plan can compare
   * "click e49 failed" against "target: <item title/price>, href available"
   * instead of re-deriving that relationship from a bare error string.
   */
  private contentItemContextFor(
    observation: PageObservation,
    action: PlannerAction
  ): { targetTitle?: string; targetPrice?: string; alternativeHref?: string; alternateActionElementId?: string } {
    if (action.action !== 'use_skill' || (action as any).skillId !== 'interaction') return {};
    const input = (action as any).input ?? {};
    if (input.action !== 'click' || !input.elementId) return {};

    const item = observation.contentItems.find((c) => {
      const primary = c.primaryActionElementId || c.linkedElementId;
      return primary === input.elementId || c.secondaryActionElementIds?.includes(input.elementId);
    });
    if (!item) return {};

    const primary = item.primaryActionElementId || item.linkedElementId;
    const failedWasPrimary = primary === input.elementId;
    const alternateActionElementId = failedWasPrimary
      ? item.secondaryActionElementIds?.[0]
      : primary;

    return {
      targetTitle: item.title,
      targetPrice: item.price,
      // Direct navigation is only ever a fallback for a *navigational* click
      // (actionRole 'link') — never offered for a button (state-changing
      // affordances like add-to-cart are not safe to bypass via raw URL).
      alternativeHref: item.actionRole === 'link' ? item.href : undefined,
      alternateActionElementId,
    };
  }
}
