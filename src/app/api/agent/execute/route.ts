import { NextRequest, NextResponse } from 'next/server';
import { BrowserController } from '@/core/browser/controller';
import { AgentExecutor } from '@/core/agent/executor';
import { ContextManager } from '@/core/context';
import { SkillRegistry } from '@/skills/registry';
import { NavigationSkill } from '@/skills/navigation';
import { ExtractionSkill } from '@/skills/extraction';
import { InteractionSkill } from '@/skills/interaction';
import { SearchSkill } from '@/skills/search';
import { Planner } from '@/core/agent/planner';
import { OmniRouteClient } from '@/core/router/client';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { goal } = body;

    if (!goal || typeof goal !== 'string') {
      return NextResponse.json(
        { error: 'Missing or invalid goal parameter' },
        { status: 400 }
      );
    }

    // Initialize JARVIS components
    const browser = new BrowserController();
    const context = new ContextManager(goal);
    const skillRegistry = new SkillRegistry();
    const omniRoute = new OmniRouteClient();

    // Register skills
    skillRegistry.register(new NavigationSkill(browser));
    skillRegistry.register(new ExtractionSkill(browser));
    skillRegistry.register(new InteractionSkill(browser));
    skillRegistry.register(new SearchSkill(browser));

    // Create planner and executor
    const planner = new Planner(omniRoute, skillRegistry, context);
    const executor = new AgentExecutor(browser, planner, context, skillRegistry, 10);

    // Execute the task
    const result = await executor.execute(goal);

    return NextResponse.json(result, { status: 200 });
  } catch (error: any) {
    console.error('Agent execution error:', error);
    return NextResponse.json(
      {
        taskId: 'error',
        goal: '',
        status: 'failed',
        result: error.message || 'Unknown error',
        steps: 0,
        tokensUsed: 0,
        actions: [],
        error: error.message,
      },
      { status: 500 }
    );
  }
}
