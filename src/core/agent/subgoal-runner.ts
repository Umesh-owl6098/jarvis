/**
 * Checkpoint 14 — executes a TaskPlan by calling the EXISTING AgentExecutor
 * once per subgoal (never nesting a new orchestrator around it), sharing one
 * BrowserController across subgoals for page continuity, and reusing the
 * EXISTING CapabilityRouter/read capability per subgoal exactly as it
 * already runs per whole task (Checkpoint 13).
 */

import { BrowserController } from '@/core/browser/controller';
import { ContextManager } from '@/core/context';
import { SkillRegistry } from '@/skills/registry';
import { NavigationSkill } from '@/skills/navigation';
import { ExtractionSkill } from '@/skills/extraction';
import { InteractionSkill } from '@/skills/interaction';
import { SearchSkill } from '@/skills/search';
import { Planner } from './planner';
import { OmniRouteClient } from '@/core/router/client';
import { AgentExecutor, ExecutionResult } from './executor';
import { EventListener } from './events';
import { routeCapability } from './capability-router';
import { resolveRead } from '@/core/capabilities/read';
import { TaskPlan, Subgoal, currentSubgoal as pickCurrent } from './subgoal';
import { attemptDeterministicRepair, attemptPlannerRepair, validateRepair, type RepairContext } from './plan-repair';
import { TargetStateStore, resolveReference, type CommittedTarget, type TargetKind } from './target-state';
import { nanoid } from 'nanoid';

export interface SubgoalTelemetry {
  id: string;
  type: string;
  status: string;
  capability: 'read' | 'browser' | 'none';
  plannerCalls: number;
  correctionRetries: number;
  tokens: number;
  steps: number;
  durationMs: number;
  evidence?: string;
}

interface SubgoalFacts {
  url?: string;
  title?: string;
  text?: string;
  price?: string;
}

export const MAX_REPLANS = 2;

export interface TaskPlanResult extends ExecutionResult {
  taskPlan: TaskPlan;
  subgoalTelemetry: SubgoalTelemetry[];
  replans: number;
  /** §12/§13 — repair-specific accounting, distinct from execution planning cost. */
  repairPlannerCalls: number;
  repairInputTokens: number;
  repairOutputTokens: number;
  repairsApplied: { subgoalId: string; method: string; reason: string }[];
}

/** Which CommittedTarget kind a subgoal's own text implies — deterministic keyword match, smallest useful set (§8). */
function inferKind(sg: Subgoal): TargetKind {
  if (sg.type === 'navigate') return 'page';
  const d = sg.description.toLowerCase();
  if (/\brepo(sitory)?\b/.test(d)) return 'repo';
  if (/\b(article|story)\b/.test(d)) return 'article';
  if (/\b(product|item|deal)\b/.test(d)) return 'product';
  return 'generic';
}

/**
 * Checkpoint 16: answer an extraction subgoal's ACTUAL question from real
 * text JARVIS already has — shared by both the "read capability already
 * fetched text" path and the "browser is already on the right page" path,
 * so an extraction subgoal never degrades into reporting just a URL/title
 * as if that were an answer. Returns null on any failure; callers fall back
 * to their own non-LLM evidence rather than block completion on this.
 */
async function answerFromText(question: string, text: string): Promise<{ answer: string; tokens: number } | null> {
  try {
    const omniroute = new OmniRouteClient();
    const response = await omniroute.generateForPlanning({
      messages: [
        {
          role: 'system',
          content:
            "Answer the question using ONLY the provided text, which is a webpage's visible text (headings, " +
            "prices, labels — not necessarily formal prose). A page's main heading is usually the name of the " +
            'thing the page is about, even with no explicit "name:" label — treat it as the answer when relevant. ' +
            'Be concise (1-3 sentences). Only say the text does not contain the answer if the text is genuinely ' +
            'unrelated to the question. Do not invent information beyond what is in the text.',
        },
        { role: 'user', content: `TEXT:\n${text.slice(0, 6000)}\n\nQUESTION: ${question}` },
      ],
    });
    return { answer: response.content.trim(), tokens: response.inputTokens + response.outputTokens };
  } catch {
    return null;
  }
}

/**
 * Deterministic substitution (§11): resolve a pronoun-continuation subgoal
 * ("open it", "tell me its title") against the STRUCTURED, OWNERSHIP-AWARE
 * target store — replaces Checkpoint 14/15's shallow priorFacts.url lookup,
 * which had no concept of WHICH subgoal produced a URL or whether it was
 * still the relevant one. A reference that can't be resolved is left
 * unchanged (§13 — never guess); it falls through to normal execution with
 * the literal text, same as an unclassified goal always has.
 */
function resolveSubgoal(
  sg: Subgoal,
  store: TargetStateStore
): { description: string; directExtract: boolean; reference: ReturnType<typeof resolveReference> } {
  const reference = resolveReference(sg.description, store);

  if (sg.type === 'interact') {
    if (reference.resolved && reference.target?.url) {
      return { description: `Open ${reference.target.url}`, directExtract: false, reference };
    }
    // The reference resolved to a REAL committed target (we know exactly
    // what "it" means — e.g. "Deal A"), but that target has no usable URL
    // (a genuinely dead link: href="#", a JS-only action, etc.). Passing the
    // bare, unmodified "open it" through leaves the planner with no concrete
    // anchor to act on, and it can lazily "finish" claiming the already-open
    // page already satisfies the task instead of actually attempting the
    // real interaction and discovering it's a dead end. Substituting the
    // matched reference text with the target's own label gives the planner
    // something concrete to click ("open Deal A") without fabricating a URL
    // — it still has to attempt a real interaction and can genuinely fail.
    if (reference.resolved && reference.target?.label && reference.reference) {
      const grounded = sg.description.replace(reference.reference, reference.target.label);
      return { description: grounded, directExtract: false, reference };
    }
    return { description: sg.description, directExtract: false, reference };
  }
  if (sg.type === 'extract') {
    return { description: sg.description, directExtract: true, reference };
  }
  if (sg.type === 'select') {
    // Two fixes, both needed for a clause like "find the top story" that
    // only makes sense in the context of the site a PRIOR subgoal already
    // opened: (1) normalize a leading find/identify verb to "select" —
    // classifyGoal's own deterministic target-phrase pattern recognizes
    // select/open/click/choose/pick, not find/identify, so leaving "find"
    // in place silently drops this subgoal to the (correct, but far more
    // expensive) planner-driven path; (2) append the most recently visited
    // SITE's name (kind:'page') so both classifyGoal AND CapabilityRouter's
    // site-specific routes (e.g. Hacker News' own API) get the same shot at
    // this subgoal they'd get if the whole task were one sentence. This is
    // deliberately NOT resolveReference — a site name isn't a "target"
    // reference (it/that/the result), it's ambient location context.
    let description = sg.description.replace(/^\s*(find|identify|locate)\b/i, 'select');
    const site = store.mostRecentOfKind('page');
    if (site?.label && !description.toLowerCase().includes(site.label.toLowerCase())) {
      description = `${description} on ${site.label}`;
    }
    return { description, directExtract: false, reference };
  }
  return { description: sg.description, directExtract: false, reference };
}

/**
 * SelectedTarget.destination is documented as "an href from its
 * ContentItem" — i.e. it can be a bare relative path, only meaningful when
 * resolved against SelectedTarget.resolvedFrom (the page it came from).
 * goal-state.ts's own reachedTarget() already resolves it this way when
 * CHECKING arrival; committedTargetFromResult must do the same before
 * storing it as a CommittedTarget's .url, since that field is later used
 * literally as `Open ${url}` for a future subgoal (resolveSubgoal's
 * 'interact' branch) — a raw relative href there produces an unnavigable
 * URL with no scheme/host. Caught via the Checkpoint 16 real-world/CP14
 * regression run: an "open it" subgoal was built as "Open
 * test-fixture-deal-detail.html" (no origin) and only "worked" by
 * coincidence because the browser happened to already be on that exact
 * page from an unrelated href-fallback recovery earlier in the same
 * subgoal.
 */
function resolveDestination(url: string, base: string): string | undefined {
  const trimmed = url.trim();
  // A bare or fragment-only href ("#", "#deal-b") is a page-internal anchor,
  // not a real destination — it has no navigable target of its own. Naively
  // resolving it against the base still produces a SYNTACTICALLY valid URL
  // (base + "#"), which looks like a genuine committed target but is really
  // just "the page you're already on" — a later "Open <url>" against it
  // would trivially "succeed" by doing nothing, masking a genuine dead end.
  // Caught via a CP15 regression fixture built specifically around
  // href="#" + a prevented click to prove no real destination exists.
  if (!trimmed || trimmed.startsWith('#')) return undefined;
  try {
    return new URL(trimmed, base).toString();
  } catch {
    return trimmed;
  }
}

/** Builds the CommittedTarget a completed subgoal should register, or undefined if this subgoal type doesn't create one (§8-9: only navigate/select/read PRODUCE targets; interact/extract only CONSUME references). */
function committedTargetFromResult(
  sg: Subgoal,
  result: ExecutionResult,
  browserUrl?: string,
  browserTitle?: string
): Omit<CommittedTarget, 'committedAt'> | undefined {
  // 'search' reaches a real, new destination just as surely as 'navigate'
  // does (e.g. Wikipedia's own search box lands directly on the matched
  // article) — it just doesn't set selectedTarget, since that field is only
  // populated by the deterministic navigate_to_target path, not a generic
  // LLM "finish" action. Without committing this, a later "open the result"
  // silently fell back to whatever the PRECEDING navigate subgoal committed
  // instead — a real stale-target leak, not a hypothetical one (caught via
  // the Checkpoint 16 real-world matrix: "search for OpenAI" then "open the
  // result" re-opened the Wikipedia homepage the task started on, not the
  // OpenAI article the search actually reached).
  if (sg.type === 'navigate' || sg.type === 'search') {
    const resolvedSelected = result.selectedTarget?.destination
      ? resolveDestination(result.selectedTarget.destination, result.selectedTarget.resolvedFrom)
      : undefined;
    const url = resolvedSelected ?? (browserUrl && browserUrl !== 'about:blank' ? browserUrl : undefined);
    if (!url) return undefined;
    return { id: `target-${sg.id}`, kind: 'page', label: browserTitle, url, sourceSubgoalId: sg.id, evidence: result.result };
  }
  if (sg.type === 'select' && result.selectedTarget) {
    return {
      id: `target-${sg.id}`,
      kind: inferKind(sg),
      label: result.selectedTarget.label,
      url: result.selectedTarget.destination
        ? resolveDestination(result.selectedTarget.destination, result.selectedTarget.resolvedFrom)
        : undefined,
      price: result.selectedTarget.price,
      sourceSubgoalId: sg.id,
      evidence: result.result,
    };
  }
  return undefined;
}

/** Minimal bookkeeping for the FINAL result summary only (§15 boundary: this is NOT reference-resolution state — that's TargetStateStore's job now). */
function factsFromExecutionResult(result: ExecutionResult, browserUrl?: string, browserTitle?: string): SubgoalFacts {
  const facts: SubgoalFacts = {};
  if (result.selectedTarget?.destination) facts.url = result.selectedTarget.destination;
  if (result.selectedTarget?.label) facts.title = result.selectedTarget.label;
  if (result.selectedTarget?.price) facts.price = result.selectedTarget.price;
  if (!facts.url && browserUrl && browserUrl !== 'about:blank') facts.url = browserUrl;
  if (!facts.title && browserTitle) facts.title = browserTitle;
  return facts;
}

/** Runs one subgoal via read capability, direct browser extraction, or a bounded AgentExecutor.execute() call. Never closes the shared browser — the caller owns that. */
async function executeSubgoal(
  sg: Subgoal,
  browser: BrowserController,
  skillRegistry: SkillRegistry,
  priorFacts: SubgoalFacts | undefined,
  store: TargetStateStore,
  signal: AbortSignal | undefined,
  parentTaskId: string,
  onEvent: EventListener
): Promise<{
  status: 'completed' | 'blocked' | 'failed';
  evidence: string;
  capability: 'read' | 'browser' | 'none';
  facts: SubgoalFacts;
  committedTarget?: Omit<CommittedTarget, 'committedAt'>;
  plannerCalls: number;
  correctionRetries: number;
  tokens: number;
  steps: number;
}> {
  const { description, directExtract } = resolveSubgoal(sg, store);

  // §11/§21: a prior READ subgoal (Wikipedia summary, GitHub README, HN
  // item...) already fetched real text and no browser was ever opened for
  // it — answer the extraction question directly from that text with ONE
  // lean completion call, not a full AgentExecutor/browser cycle the prior
  // subgoal gave us nothing to observe with anyway. This is answering an
  // extraction question with content JARVIS already has, not "another LLM
  // call for routing" — routing already happened deterministically.
  if (directExtract && priorFacts?.text && !browser.isAlive()) {
    const answered = await answerFromText(sg.description, priorFacts.text);
    if (answered) {
      return {
        status: 'completed',
        evidence: answered.answer,
        capability: 'none',
        facts: { text: answered.answer, title: priorFacts.title, url: priorFacts.url },
        plannerCalls: 1,
        correctionRetries: 0,
        tokens: answered.tokens,
        steps: 0,
      };
    }
    // fall through to the normal routed path below
  }

  // §12: extract from the page we're already on — no new navigation. Reads
  // the CURRENT page's real visible text and answers the actual question
  // (sg.description), same as the priorFacts.text branch above — this used
  // to just report url/title with a generic "no new navigation needed"
  // placeholder as the "answer," which silently never addressed what the
  // subgoal actually asked (caught via the Checkpoint 16 real-world matrix:
  // "tell me the first sentence of the article" was reported completed with
  // only the page title as evidence, never the actual sentence).
  if (directExtract && browser.isAlive()) {
    try {
      const [url, title] = await Promise.all([browser.getURL(), browser.getTitle().catch(() => '')]);
      if (url && url !== 'about:blank') {
        const pageText = await browser.getVisibleText().catch(() => '');
        const answered = pageText ? await answerFromText(sg.description, pageText) : null;
        return {
          status: 'completed',
          evidence: answered ? answered.answer : `Read directly from ${url}${title ? ` (${title})` : ''} — no new navigation needed.`,
          capability: 'none',
          facts: { text: answered?.answer, url, title },
          plannerCalls: answered ? 1 : 0,
          correctionRetries: 0,
          tokens: answered?.tokens ?? 0,
          steps: 0,
        };
      }
    } catch {
      // fall through to the routed path below
    }
  }

  const decision = routeCapability(description);

  // Checkpoint 15: deterministic repair can force browser after a read
  // failure — skip the read branch entirely rather than trusting routing
  // to happen to land on browser again.
  if (decision.selectedCapability === 'read' && sg.forceCapability !== 'browser') {
    const outcome = await resolveRead(decision.readSource, decision.readUrl, decision.readMeta, signal);

    if (outcome.ok) {
      return {
        status: 'completed',
        evidence: `Read ${outcome.result.url}${outcome.result.title ? ` (${outcome.result.title})` : ''}.`,
        capability: 'read',
        facts: { url: outcome.result.url, title: outcome.result.title, text: outcome.result.text },
        // A successful read IS a commitment — "this is the resource JARVIS
        // selected for this subgoal" — exactly like a browser-side 'select'.
        committedTarget: {
          id: `target-${sg.id}`,
          kind: inferKind(sg),
          label: outcome.result.title,
          url: outcome.result.url,
          sourceSubgoalId: sg.id,
          evidence: `Read ${outcome.result.url}`,
        },
        plannerCalls: 0,
        correctionRetries: 0,
        tokens: 0,
        steps: 0,
      };
    }
    // A read failure is a real subgoal failure, reported honestly and
    // handed to runTaskPlan's repair logic — NOT silently absorbed by
    // falling through to browser inline here. Checkpoint 14 did exactly
    // that (an inline, untracked fallback); Checkpoint 15's whole point is
    // that repairs must be genuine, visible, and accounted for
    // (repairsApplied, repairPlannerCalls) rather than happening for free
    // where nothing can see them.
    return {
      status: 'failed',
      evidence: outcome.error,
      capability: 'read',
      facts: {},
      plannerCalls: 0,
      correctionRetries: 0,
      tokens: 0,
      steps: 0,
    };
  }

  // Browser path — one bounded AgentExecutor.execute() call, browser stays open (closeBrowserOnFinish=false).
  const context = new ContextManager(description);
  const planner = new Planner(new OmniRouteClient(), skillRegistry, context);
  const executor = new AgentExecutor(browser, planner, context, skillRegistry, 10, 40000, 150000, false);
  // Forward this subgoal's own observe/plan/act events to the plan-level
  // listener — without this, the live UI (and any cancellation trigger
  // watching for a specific event) sees only the two events runTaskPlan
  // emits itself for the WHOLE plan, and nothing from any individual
  // subgoal's execution in between.
  const unsubscribe = executor.getEventCollector().subscribe(onEvent);
  let result: ExecutionResult;
  try {
    result = await executor.execute(description, signal, `${parentTaskId}-${sg.id}`);
  } finally {
    unsubscribe();
  }

  const [browserUrl, browserTitle] = await Promise.all([
    browser.getURL().catch(() => undefined),
    browser.getTitle().catch(() => undefined),
  ]);
  const facts = factsFromExecutionResult(result, browserUrl, browserTitle);

  const status: 'completed' | 'blocked' | 'failed' =
    result.status === 'success' ? 'completed' : result.outcome === 'blocked' ? 'blocked' : 'failed';

  return {
    status,
    evidence: result.result,
    capability: 'browser',
    facts,
    committedTarget: status === 'completed' ? committedTargetFromResult(sg, result, browserUrl, browserTitle) : undefined,
    // Checkpoint 15: exact, from ContextManager's own counter via
    // ExecutionResult.plannerCalls — replaces Checkpoint 14's
    // Math.max(1, steps) approximation, which over-counted a subgoal that
    // completed deterministically (real steps, zero planner calls) and
    // under-counted one that needed a schema-retry (extra planner call,
    // same step).
    plannerCalls: result.plannerCalls ?? 0,
    correctionRetries: result.correctionRetries ?? 0,
    tokens: result.tokensUsed,
    steps: result.steps,
  };
}

export async function runTaskPlan(
  plan: TaskPlan,
  onEvent: EventListener,
  signal?: AbortSignal,
  taskId?: string
): Promise<TaskPlanResult> {
  const id = taskId || nanoid();
  const browser = new BrowserController();
  const skillRegistry = new SkillRegistry();
  skillRegistry.register(new NavigationSkill(browser));
  skillRegistry.register(new ExtractionSkill(browser));
  skillRegistry.register(new InteractionSkill(browser));
  skillRegistry.register(new SearchSkill(browser));

  const subgoalFacts = new Map<string, SubgoalFacts>();
  const telemetry: SubgoalTelemetry[] = [];
  const activationCounts = new Map<string, number>();
  let totalTokens = 0;
  let totalSteps = 0;
  let totalPlannerCalls = 0;
  let totalCorrectionRetries = 0;
  let browserTouched = false;
  // §12/§13 — repair cost tracked separately from execution planning cost.
  const omniroute = new OmniRouteClient();
  let repairPlannerCalls = 0;
  let repairInputTokens = 0;
  let repairOutputTokens = 0;
  const repairsApplied: { subgoalId: string; method: string; reason: string }[] = [];

  onEvent({
    type: 'task.started',
    timestamp: Date.now(),
    taskId: id,
    data: { task: plan.originalGoal, subgoalCount: plan.subgoals.length },
  });

  // CP13's Developer Inspector row and its test suite read result.capability
  // on every ExecutionResult, not just single-shot ones — without this, a
  // multi-subgoal plan's result silently carried no capability info at all.
  const overallCapability = (): ExecutionResult['capability'] => ({
    selected: browserTouched ? 'browser' : 'read',
    reason: `Multi-step plan (${plan.subgoals.length} subgoals) — see taskPlan.subgoals for the capability each one used.`,
    readAttempted: telemetry.some((t) => t.capability === 'read'),
    browserFallbackUsed: false,
  });

  const stop = (result: string): TaskPlanResult => ({
    taskId: id,
    goal: plan.originalGoal,
    status: 'stopped',
    result,
    steps: totalSteps,
    tokensUsed: totalTokens,
    plannerCalls: totalPlannerCalls,
    correctionRetries: totalCorrectionRetries,
    actions: [],
    events: [],
    taskPlan: plan,
    subgoalTelemetry: telemetry,
    replans: plan.replans,
    capability: overallCapability(),
    repairPlannerCalls, repairInputTokens, repairOutputTokens, repairsApplied,
  });

  try {
    let priorFacts: SubgoalFacts | undefined;
    // §8-13: replaces priorFacts for target REFERENCE resolution — an
    // explicit, ownership-tracked history instead of a shallow merge.
    // priorFacts survives alongside it only for the `.text` field (raw
    // retrieved content for the direct-answer path), which isn't a "target".
    const targetStore = new TargetStateStore();

    for (let idx = 0; idx < plan.subgoals.length; idx++) {
      if (signal?.aborted) return stop('Task was cancelled by user');

      const sg = plan.subgoals[idx];
      sg.status = 'active';
      const activations = (activationCounts.get(sg.id) ?? 0) + 1;
      activationCounts.set(sg.id, activations);

      // Defensive backstop, not the primary path: the replan-exhaustion
      // branch below always returns once plan.replans hits MAX_REPLANS, so
      // activations should never actually exceed MAX_REPLANS + 1 in normal
      // flow. Kept in case that invariant is ever broken by a future change.
      if (activations > MAX_REPLANS + 1) {
        sg.status = 'failed';
        onEvent({ type: 'agent.failed', timestamp: Date.now(), taskId: id, data: { reason: 'SUBGOAL_LOOP_DETECTED', subgoalId: sg.id } });
        return {
          taskId: id, goal: plan.originalGoal, status: 'failed', outcome: 'failed',
          result: `SUBGOAL_LOOP_DETECTED: "${sg.id}" (${sg.description}) was reactivated ${activations} times without completing.`,
          steps: totalSteps, tokensUsed: totalTokens, plannerCalls: totalPlannerCalls, correctionRetries: totalCorrectionRetries, actions: [], events: [],
          taskPlan: plan, subgoalTelemetry: telemetry, replans: plan.replans, capability: overallCapability(),
        repairPlannerCalls, repairInputTokens, repairOutputTokens, repairsApplied,
        };
      }

      const subStart = Date.now();
      const outcome = await executeSubgoal(sg, browser, skillRegistry, priorFacts, targetStore, signal, id, onEvent);
      if (outcome.capability === 'browser') browserTouched = true;

      // §19: a subgoal's own AgentExecutor.execute() can return mid-flight
      // because the shared signal fired DURING this subgoal, not only
      // between subgoals. Without this check that cancellation would be
      // misread as a plain subgoal failure and trigger a replan instead of
      // stopping the whole plan immediately.
      if (signal?.aborted) return stop('Task was cancelled by user');

      totalTokens += outcome.tokens;
      totalSteps += outcome.steps;
      totalPlannerCalls += outcome.plannerCalls;
      totalCorrectionRetries += outcome.correctionRetries;
      telemetry.push({
        id: sg.id, type: sg.type, status: outcome.status, capability: outcome.capability,
        plannerCalls: outcome.plannerCalls, correctionRetries: outcome.correctionRetries, tokens: outcome.tokens, steps: outcome.steps,
        durationMs: Date.now() - subStart, evidence: outcome.evidence,
      });

      if (outcome.status === 'completed') {
        sg.status = 'completed';
        sg.evidence = outcome.evidence;
        sg.capability = outcome.capability === 'none' ? 'browser' : outcome.capability;
        priorFacts = { ...priorFacts, ...outcome.facts };
        subgoalFacts.set(sg.id, outcome.facts);
        // §9: explicit ownership — this target is stamped with the subgoal
        // that produced it, so a later unrelated subgoal's own commit can
        // never be confused with it, and reference resolution always knows
        // exactly which subgoal a resolved "it"/"that" came from.
        if (outcome.committedTarget) targetStore.commit(outcome.committedTarget);
        continue;
      }

      // §7-11: subgoal did not complete. Attempt genuine repair — deterministic
      // first, planner-based only if no deterministic evidence applies — before
      // ever falling back to a blind retry. Completed subgoals are never
      // touched; only [failed, ...remaining] can be replaced.
      if (plan.replans < MAX_REPLANS) {
        plan.replans++;
        // §14: repair must use a committed target's URL ONLY if the FAILED
        // subgoal's own text actually references it — resolveReference is
        // the same ownership-aware lookup executeSubgoal uses, not a blind
        // "whatever's most recently active" grab.
        const targetRef = resolveReference(sg.description, targetStore);
        const repairCtx: RepairContext = {
          overallGoal: plan.originalGoal,
          completedSubgoals: plan.subgoals.filter((s) => s.status === 'completed').map((s) => ({ id: s.id, description: s.description, evidence: s.evidence })),
          committedTarget: targetRef.resolved ? targetRef.target : undefined,
          failedSubgoal: sg,
          failureEvidence: outcome.evidence,
          currentObservation: browser.isAlive() ? { url: await browser.getURL().catch(() => undefined) } : undefined,
          remainingSubgoals: plan.subgoals.slice(idx + 1),
        };

        let repair = attemptDeterministicRepair(repairCtx);
        if (!repair.repaired) {
          repairPlannerCalls++;
          repair = await attemptPlannerRepair(repairCtx, omniroute);
          if (repair.inputTokens != null && repair.outputTokens != null) {
            repairInputTokens += repair.inputTokens;
            repairOutputTokens += repair.outputTokens;
            totalTokens += repair.inputTokens + repair.outputTokens;
          }
        }

        // §19 (this checkpoint's own cancellation requirement): OmniRoute
        // has no in-flight request cancellation (true throughout this
        // codebase, not new here — the regular planner loop only checks
        // signal between steps too), so a repair call in flight when
        // cancel() fires cannot be interrupted mid-request. What we CAN and
        // must guarantee: its result is never applied and no further
        // subgoal starts once the signal is aborted.
        if (signal?.aborted) return stop('Task was cancelled by user');

        if (repair.repaired && repair.newSubgoals) {
          const validation = validateRepair(plan, sg.id, repair.newSubgoals, repair.method as 'deterministic' | 'planner');
          if (validation.ok) {
            plan.subgoals.splice(idx, plan.subgoals.length - idx, ...repair.newSubgoals);
            repairsApplied.push({ subgoalId: sg.id, method: repair.method, reason: repair.reason });
            idx--; // retry at the same index — now holding the repaired subgoal
            onEvent({
              type: 'agent.recovery',
              timestamp: Date.now(),
              taskId: id,
              data: { reason: `plan repair (${repair.method})`, subgoalId: sg.id, detail: repair.reason },
            });
            continue;
          }
          // Repair proposed but failed an invariant — do not apply it, fall through to a plain retry.
          onEvent({ type: 'agent.recovery', timestamp: Date.now(), taskId: id, data: { reason: 'repair rejected', subgoalId: sg.id, detail: validation.reason } });
        }

        // No applicable repair (or a rejected one) — fall back to the
        // Checkpoint 14 behavior: plain retry of the same subgoal, still
        // bounded by the same replan budget just spent above.
        idx--;
        onEvent({ type: 'agent.recovery', timestamp: Date.now(), taskId: id, data: { reason: 'subgoal retry (no repair applicable)', subgoalId: sg.id, attempt: plan.replans } });
        continue;
      }

      // Replans exhausted.
      if (sg.optional) {
        sg.status = 'blocked';
        sg.evidence = outcome.evidence;
        priorFacts = { ...priorFacts, ...outcome.facts };
        continue; // §18: optional failure does not fail the task
      }

      sg.status = outcome.status;
      const doneIds = plan.subgoals.filter((s) => s.status === 'completed').map((s) => s.id);
      // §16: this subgoal was reactivated (replanned) and still never
      // completed — that IS "same subgoal repeatedly reactivated" from the
      // loop-protection spec, so it gets the same explicit code, not a
      // generic failure message. A subgoal that fails on its very first
      // activation (no replan budget left to even retry it) is a plain
      // required-subgoal failure instead — it was never actually looping.
      const loopDetected = activations > 1;
      onEvent({ type: 'agent.failed', timestamp: Date.now(), taskId: id, data: { reason: loopDetected ? 'SUBGOAL_LOOP_DETECTED' : 'required subgoal failed', subgoalId: sg.id } });
      return {
        taskId: id, goal: plan.originalGoal, status: 'failed', outcome: outcome.status === 'blocked' ? 'blocked' : 'failed',
        result: loopDetected
          ? `SUBGOAL_LOOP_DETECTED: "${sg.id}" (${sg.description}) was reactivated ${activations} times without completing. Completed ${doneIds.join(', ') || 'no subgoals'} before this.`
          : `Completed ${doneIds.join(', ') || 'no subgoals'}; required subgoal "${sg.id}" (${sg.description}) ${outcome.status}: ${outcome.evidence}`,
        steps: totalSteps, tokensUsed: totalTokens, plannerCalls: totalPlannerCalls, correctionRetries: totalCorrectionRetries, actions: [], events: [],
        taskPlan: plan, subgoalTelemetry: telemetry, replans: plan.replans, capability: overallCapability(),
        repairPlannerCalls, repairInputTokens, repairOutputTokens, repairsApplied,
      };
    }

    const blockedOptional = plan.subgoals.filter((s) => s.status === 'blocked');
    // The LAST completed subgoal's own facts, not a merge of every prior
    // subgoal's — a merge lets an early subgoal's stale `text` field
    // outlive its relevance (e.g. a 'select' subgoal's summary text
    // surviving past a LATER 'extract' subgoal that found the real,
    // different answer on the actual destination page).
    const lastCompleted = [...plan.subgoals].reverse().find((s) => s.status === 'completed');
    const finalFacts = (lastCompleted && subgoalFacts.get(lastCompleted.id)) ?? priorFacts ?? {};
    const summary = finalFacts.text
      ? `${finalFacts.text.slice(0, 500)}`
      : finalFacts.title
        ? `${finalFacts.title}${finalFacts.url ? ` (${finalFacts.url})` : ''}`
        : plan.subgoals[plan.subgoals.length - 1]?.evidence ?? 'Completed.';
    const disclosure = blockedOptional.length
      ? ` [optional step(s) skipped: ${blockedOptional.map((s) => s.id).join(', ')}]`
      : '';

    onEvent({ type: 'agent.completed', timestamp: Date.now(), taskId: id, data: { result: summary } });
    return {
      taskId: id, goal: plan.originalGoal, status: 'success', outcome: 'completed',
      result: `${summary}${disclosure}`,
      steps: totalSteps, tokensUsed: totalTokens, plannerCalls: totalPlannerCalls, correctionRetries: totalCorrectionRetries, actions: [], events: [],
      taskPlan: plan, subgoalTelemetry: telemetry, replans: plan.replans, capability: overallCapability(),
        repairPlannerCalls, repairInputTokens, repairOutputTokens, repairsApplied,
    };
  } finally {
    if (browserTouched) await browser.close().catch(() => {});
  }
}
