import { NextRequest } from 'next/server';
import { nanoid } from 'nanoid';
import { runTask } from '@/core/agent/task-manager';
import { AgentEvent } from '@/core/agent/events';
import { BrowserController } from '@/core/browser/controller';
import { AgentExecutor } from '@/core/agent/executor';
import { ContextManager } from '@/core/context';
import { SkillRegistry } from '@/skills/registry';
import { NavigationSkill } from '@/skills/navigation';
import { ExtractionSkill } from '@/skills/extraction';
import { InteractionSkill } from '@/skills/interaction';
import { SearchSkill } from '@/skills/search';
import { Planner } from '@/core/agent/planner';
import { MockOmniRoute } from '@/core/router/mock';
import { SlowMockOmniRoute } from '@/core/router/mock-slow';
import { FailingMockOmniRoute } from '@/core/router/mock-failing';
import { resolveRouterMode, isMockMode, ROUTER_MODE_LABEL } from '@/core/router/mode';
import { taskRegistry } from '@/core/agent/task-registry';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  let goal: string;
  try {
    const body = await request.json();
    goal = body.goal;
    if (!goal || typeof goal !== 'string') {
      return new Response(JSON.stringify({ error: 'Missing or invalid goal parameter' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid request body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const taskId = nanoid();
  const abortController = new AbortController();
  const encoder = new TextEncoder();
  let streamClosed = false;
  let controller: ReadableStreamDefaultController | null = null;

  // Register task for cancellation
  taskRegistry.registerTask(taskId, abortController);

  function sendEvent(event: AgentEvent) {
    if (streamClosed || !controller) return;
    try {
      const sseData = `event: ${event.type}\ndata: ${JSON.stringify({
        type: event.type,
        taskId: event.taskId,
        timestamp: event.timestamp,
        stepNumber: event.stepNumber,
        data: event.data,
      })}\n\n`;
      controller.enqueue(encoder.encode(sseData));
    } catch {}
  }

  // Single source of truth; mocks require explicit opt-in and are refused in production.
  const routerMode = resolveRouterMode();
  const useMock = routerMode === 'mock';
  const useSlowMock = routerMode === 'slow-mock';
  const useFailingMock = routerMode === 'failing-mock';

  console.log(
    `[stream] router=${ROUTER_MODE_LABEL[routerMode]} taskId=${taskId} goal=${JSON.stringify(goal)}`
  );
  // Command integrity: prove the operator's string is unchanged at this hop.
  console.log(
    `[integrity] SSEBody.task=${JSON.stringify(goal)} len=${goal.length}`
  );

  const stream = new ReadableStream({
    start(ctrl) {
      controller = ctrl;

      const taskPromise =
        useMock || useSlowMock || useFailingMock
          ? (async () => {
              const browser = new BrowserController();
              const context = new ContextManager(goal);
              const skillRegistry = new SkillRegistry();
              const mockRouter = useFailingMock
                ? new FailingMockOmniRoute(abortController.signal)
                : useSlowMock
                  ? new SlowMockOmniRoute(abortController.signal)
                  : new MockOmniRoute();

              skillRegistry.register(new NavigationSkill(browser));
              skillRegistry.register(new ExtractionSkill(browser));
              skillRegistry.register(new InteractionSkill(browser));
    skillRegistry.register(new SearchSkill(browser));

              const planner = new Planner(mockRouter as any, skillRegistry, context);
              const executor = new AgentExecutor(browser, planner, context, skillRegistry, 10);

              const unsubscribe = executor.getEventCollector().subscribe(sendEvent);
              try {
                return await executor.execute(goal, abortController.signal, taskId);
              } finally {
                unsubscribe();
              }
            })()
          : runTask({ goal, onEvent: sendEvent, signal: abortController.signal, taskId });

      taskPromise.then(result => {
        if (streamClosed) return;
        try {
          // Check if task was cancelled
          if (abortController.signal.aborted) {
            taskRegistry.completeTask(taskId, 'stopped');
            const stoppedData = `event: task.stopped\ndata: ${JSON.stringify({
              taskId,
              reason: 'user_cancelled',
              timestamp: Date.now(),
            })}\n\n`;
            ctrl.enqueue(encoder.encode(stoppedData));
          } else {
            taskRegistry.completeTask(taskId, result?.status === 'success' ? 'completed' : 'failed');
            const finalData = `event: task.result\ndata: ${JSON.stringify(result)}\n\n`;
            ctrl.enqueue(encoder.encode(finalData));
          }
          ctrl.close();
        } catch {}
      }).catch(error => {
        if (streamClosed) return;
        try {
          if (abortController.signal.aborted) {
            taskRegistry.completeTask(taskId, 'stopped');
            const stoppedData = `event: task.stopped\ndata: ${JSON.stringify({
              taskId,
              reason: 'user_cancelled',
              timestamp: Date.now(),
            })}\n\n`;
            ctrl.enqueue(encoder.encode(stoppedData));
          } else {
            taskRegistry.completeTask(taskId, 'failed');
            const errData = `event: task.error\ndata: ${JSON.stringify({
              error: error?.message || 'Unknown error',
            })}\n\n`;
            ctrl.enqueue(encoder.encode(errData));
          }
          ctrl.close();
        } catch {}
      }).finally(() => {
        // Cleanup periodically
        taskRegistry.cleanupCompleted();
      });
    },
    cancel() {
      streamClosed = true;
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
