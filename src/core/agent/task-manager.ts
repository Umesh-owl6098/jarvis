import { BrowserController } from '@/core/browser/controller';
import { AgentExecutor, ExecutionResult } from './executor';
import { ContextManager } from '@/core/context';
import { SkillRegistry } from '@/skills/registry';
import { NavigationSkill } from '@/skills/navigation';
import { ExtractionSkill } from '@/skills/extraction';
import { InteractionSkill } from '@/skills/interaction';
import { SearchSkill } from '@/skills/search';
import { Planner } from './planner';
import { OmniRouteClient } from '@/core/router/client';
import { AgentEvent, EventListener } from './events';
import { routeCapability, type CapabilityDecision } from './capability-router';
import { resolveRead } from '@/core/capabilities/read';
import { classifyGoal } from './goal-state';
import { decomposeTask, validatePlan, type TaskPlan } from './subgoal';
import { runTaskPlan } from './subgoal-runner';
import { nanoid } from 'nanoid';

export interface RunTaskOptions {
  goal: string;
  onEvent: EventListener;
  signal?: AbortSignal;
  taskId?: string;
}

/**
 * Attempt the read capability. Returns a completed ExecutionResult on
 * success, or null when the caller should fall back to the browser path —
 * never throws. Read is attempted AT MOST ONCE; there is no retry loop, so
 * this cannot spin.
 */
async function attemptRead(
  goal: string,
  taskId: string,
  decision: CapabilityDecision,
  onEvent: EventListener,
  signal?: AbortSignal
): Promise<{ result?: ExecutionResult; failure?: string }> {
  onEvent({ type: 'task.started', timestamp: Date.now(), taskId, data: { task: goal, capability: 'read' } });

  const outcome = await resolveRead(decision.readSource, decision.readUrl, decision.readMeta, signal);

  if (!outcome.ok) {
    return { failure: outcome.error };
  }

  const { result: retrieval } = outcome;
  const preview = retrieval.text.length > 2000 ? `${retrieval.text.slice(0, 2000)}…` : retrieval.text;
  const resultText = retrieval.title
    ? `Read ${retrieval.url} (${retrieval.title}):\n\n${preview}`
    : `Read ${retrieval.url}:\n\n${preview}`;

  onEvent({ type: 'agent.completed', timestamp: Date.now(), taskId, data: { result: resultText, capability: 'read' } });

  return {
    result: {
      taskId,
      goal,
      status: 'success',
      outcome: 'completed',
      result: resultText,
      steps: 0,
      tokensUsed: 0,
      actions: [`read:${retrieval.source} (${retrieval.url})`],
      events: [],
    },
  };
}

export async function runTask(options: RunTaskOptions): Promise<ExecutionResult> {
  const { goal, onEvent, signal, taskId: providedTaskId } = options;
  console.log(`[integrity] runTask.task=${JSON.stringify(goal)} len=${goal.length}`);

  // Checkpoint 14: only ever consider subgoal decomposition when the
  // existing single-goal classifier has nothing to offer for the WHOLE
  // task — anything classifyGoal already understands (navigate,
  // navigate_to_target, navigate_and_extract, search, search_and_open)
  // keeps running through the unmodified single-shot path below.
  const wholeTaskClassification = classifyGoal(goal);
  if (wholeTaskClassification.goalType === 'unclassified') {
    const decomposition = decomposeTask(goal);
    if (decomposition && 'rejected' in decomposition) {
      const taskId = providedTaskId || nanoid();
      console.log(`[subgoal] decomposition rejected: ${decomposition.rejected}`);
      return {
        taskId,
        goal,
        status: 'failed',
        outcome: 'failed',
        result: `Task not attempted: ${decomposition.rejected}`,
        steps: 0,
        tokensUsed: 0,
        actions: [],
        events: [],
      };
    }
    if (decomposition && 'subgoals' in decomposition) {
      const validation = validatePlan(decomposition.subgoals);
      if (validation.ok) {
        const plan: TaskPlan = { originalGoal: goal, subgoals: decomposition.subgoals, replans: 0 };
        console.log(
          `[subgoal] decomposed "${goal}" into ${plan.subgoals.length} subgoals: ${plan.subgoals.map((s) => `${s.id}:${s.type}`).join(', ')}`
        );
        return runTaskPlan(plan, onEvent, signal, providedTaskId);
      }
      console.log(`[subgoal] decomposition rejected by validator ("${validation.reason}") — falling back to single-shot`);
    }
  }

  const decision = routeCapability(goal);
  console.log(`[capability] selected=${decision.selectedCapability} reason="${decision.routingReason}"`);

  if (decision.selectedCapability === 'read') {
    const taskId = providedTaskId || nanoid();
    const { result: readResult, failure } = await attemptRead(goal, taskId, decision, onEvent, signal);

    if (readResult) {
      readResult.capability = {
        selected: 'read',
        reason: decision.routingReason,
        readAttempted: true,
        browserFallbackUsed: false,
      };
      return readResult;
    }

    // A cancelled read must end the task, not silently launch a browser.
    if (signal?.aborted) {
      return {
        taskId,
        goal,
        status: 'stopped',
        result: 'Task was cancelled by user',
        steps: 0,
        tokensUsed: 0,
        actions: [],
        events: [],
        capability: {
          selected: 'read',
          reason: decision.routingReason,
          readAttempted: true,
          readFailure: failure,
          browserFallbackUsed: false,
        },
      };
    }

    console.log(`[capability] read failed (${failure}) — falling back to browser`);
    const browserResult = await runBrowserTask({ goal, onEvent, signal, taskId });
    browserResult.capability = {
      selected: 'browser',
      reason: decision.routingReason,
      fallbackCapability: 'browser',
      readAttempted: true,
      readFailure: failure,
      browserFallbackUsed: true,
    };
    return browserResult;
  }

  const result = await runBrowserTask({ goal, onEvent, signal, taskId: providedTaskId });
  result.capability = {
    selected: 'browser',
    reason: decision.routingReason,
    readAttempted: false,
    browserFallbackUsed: false,
  };
  return result;
}

async function runBrowserTask(options: RunTaskOptions): Promise<ExecutionResult> {
  const { goal, onEvent, signal, taskId } = options;

  const browser = new BrowserController();
  const context = new ContextManager(goal);
  const skillRegistry = new SkillRegistry();
  const omniRoute = new OmniRouteClient();

  skillRegistry.register(new NavigationSkill(browser));
  skillRegistry.register(new ExtractionSkill(browser));
  skillRegistry.register(new InteractionSkill(browser));
  skillRegistry.register(new SearchSkill(browser));

  const planner = new Planner(omniRoute, skillRegistry, context);
  const executor = new AgentExecutor(browser, planner, context, skillRegistry, 10);

  const unsubscribe = executor.getEventCollector().subscribe(onEvent);

  try {
    return await executor.execute(goal, signal, taskId);
  } finally {
    unsubscribe();
  }
}
