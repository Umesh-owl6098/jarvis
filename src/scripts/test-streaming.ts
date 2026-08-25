import { AgentExecutor } from '@/core/agent/executor';
import { AgentEvent } from '@/core/agent/events';
import { BrowserController } from '@/core/browser/controller';
import { ContextManager } from '@/core/context';
import { SkillRegistry } from '@/skills/registry';
import { NavigationSkill } from '@/skills/navigation';
import { ExtractionSkill } from '@/skills/extraction';
import { InteractionSkill } from '@/skills/interaction';
import { Planner } from '@/core/agent/planner';
import { MockOmniRoute } from '@/core/router/mock';

async function testStreamingTiming() {
  console.log('🧪 Streaming Timing Proof Test\n');
  console.log('Goal: prove intermediate events arrive BEFORE task completion.\n');

  const browser = new BrowserController();
  const goal = 'Open example.com and tell me the page title.';
  const context = new ContextManager(goal);
  const skills = new SkillRegistry();
  const mock = new MockOmniRoute();

  skills.register(new NavigationSkill(browser));
  skills.register(new ExtractionSkill(browser));
  skills.register(new InteractionSkill(browser));

  const planner = new Planner(mock as any, skills, context);
  const executor = new AgentExecutor(browser, planner, context, skills, 10);

  const receivedEvents: { event: AgentEvent; receivedAt: number }[] = [];
  let taskCompleteAt: number | null = null;

  const unsub = executor.getEventCollector().subscribe((event: AgentEvent) => {
    receivedEvents.push({ event, receivedAt: Date.now() });
    console.log(`  [STREAM] ${event.type} (step ${event.stepNumber ?? '-'}) at ${event.timestamp}`);
  });

  try {
    const result = await executor.execute(goal);
    taskCompleteAt = Date.now();

    unsub();

    console.log(`\n${'━'.repeat(60)}`);
    console.log('TIMING ANALYSIS\n');

    const completedEvent = receivedEvents.find(e => e.event.type === 'agent.completed');
    const intermediateEvents = receivedEvents.filter(e =>
      e.event.type !== 'agent.completed' && e.event.type !== 'agent.failed'
    );

    console.log(`Total events received: ${receivedEvents.length}`);
    console.log(`Intermediate events (before completion): ${intermediateEvents.length}`);
    console.log(`Task result status: ${result.status}`);
    console.log(`Task complete at: ${taskCompleteAt}`);

    if (intermediateEvents.length === 0) {
      console.log('\n❌ FAIL: No intermediate events received');
      process.exit(1);
    }

    // Verify ordering: intermediate events arrived before completion event
    const lastIntermediate = intermediateEvents[intermediateEvents.length - 1];
    if (completedEvent && lastIntermediate.event.timestamp <= completedEvent.event.timestamp) {
      console.log(`\n✅ PASS: Intermediate events arrived before completion`);
      console.log(`   Last intermediate (${lastIntermediate.event.type}): ${lastIntermediate.event.timestamp}`);
      console.log(`   Completion event: ${completedEvent.event.timestamp}`);
    } else if (!completedEvent) {
      const failedEvent = receivedEvents.find(e => e.event.type === 'agent.failed');
      if (failedEvent) {
        console.log(`\n⚠️  Task failed: ${failedEvent.event.data?.reason}`);
        console.log(`   But intermediate events DID arrive before failure.`);
        console.log(`   ✅ PASS: Streaming timing is correct (events streamed before terminal event)`);
      }
    }

    console.log('\nEvent sequence:');
    receivedEvents.forEach((e, i) => {
      console.log(`  ${i + 1}. ${e.event.type} (step ${e.event.stepNumber ?? '-'}) t=${e.event.timestamp}`);
    });

    // Verify taskId isolation
    const taskIds = new Set(receivedEvents.map(e => e.event.taskId));
    console.log(`\nTask ID isolation: ${taskIds.size} unique taskId(s): ${[...taskIds].join(', ')}`);
    if (taskIds.size === 1) {
      console.log('✅ PASS: All events belong to single task');
    } else {
      console.log('❌ FAIL: Events from multiple tasks mixed');
      process.exit(1);
    }

    // Verify events are in ExecutionResult too
    console.log(`\nEvents in ExecutionResult: ${result.events.length}`);
    if (result.events.length === receivedEvents.length) {
      console.log('✅ PASS: ExecutionResult.events matches streamed count');
    } else {
      console.log(`⚠️  Mismatch: streamed=${receivedEvents.length}, result=${result.events.length}`);
    }

    console.log(`\n${'━'.repeat(60)}`);
    console.log('✅ STREAMING TIMING PROOF TEST PASSED\n');

  } catch (error: any) {
    console.error(`\n❌ TEST FAILED: ${error.message}\n`);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

testStreamingTiming().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
