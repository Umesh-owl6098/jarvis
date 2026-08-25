/**
 * Autonomous Agent Test
 *
 * Tests the complete JARVIS agent loop with mock LLM.
 *
 * Task: "Open example.com and tell me the page title"
 *
 * Expected flow:
 * Step 1: Navigate to example.com
 * Step 2: Observe page (get title, elements, etc)
 * Step 3: Plan: Extract title
 * Step 4: Execute extraction
 * Step 5: Finish with result
 *
 * This test does NOT require:
 * - Real API keys
 * - OmniRoute running
 * - Network access to LLM providers
 *
 * It demonstrates the complete agent architecture working end-to-end.
 */

import { BrowserController } from '@/core/browser/controller';
import { Planner } from '@/core/agent/planner';
import { AgentExecutor } from '@/core/agent/executor';
import { ContextManager } from '@/core/context';
import { SkillRegistry } from '@/skills/registry';
import { NavigationSkill } from '@/skills/navigation';
import { ExtractionSkill } from '@/skills/extraction';
import { InteractionSkill } from '@/skills/interaction';
import { MockOmniRoute } from '@/core/router/mock';

async function runAutonomousAgent() {
  console.log('\n🤖 JARVIS Autonomous Agent Test\n');
  console.log('📋 Task: "Open example.com and tell me the page title"\n');
  console.log('━'.repeat(60));

  const browser = new BrowserController();
  const context = new ContextManager('Open example.com and tell me the page title');
  const skillRegistry = new SkillRegistry();
  const mockRouter = new MockOmniRoute();
  const planner = new Planner(mockRouter as any, skillRegistry, context);
  const executor = new AgentExecutor(browser, planner, context, skillRegistry, 10);

  // Register skills
  skillRegistry.register(new NavigationSkill(browser));
  skillRegistry.register(new ExtractionSkill(browser));
  skillRegistry.register(new InteractionSkill(browser));

  try {
    const result = await executor.execute('Open example.com and tell me the page title');

    console.log('\n' + '━'.repeat(60));
    console.log('✅ TEST COMPLETED\n');
    console.log('📊 Results:');
    console.log(`   • Task ID: ${result.taskId}`);
    console.log(`   • Status: ${result.status}`);
    console.log(`   • Steps: ${result.steps}`);
    console.log(`   • Tokens used: ${result.tokensUsed}`);
    console.log(`   • Result: ${result.result}`);
    console.log(`   • Actions: ${result.actions.join(' → ')}`);
    console.log('');

    if (result.status === 'success') {
      console.log('✅ AUTONOMOUS AGENT TEST PASSED\n');
      process.exit(0);
    } else {
      console.log('❌ AUTONOMOUS AGENT TEST FAILED\n');
      console.log(`Error: ${result.error}\n`);
      process.exit(1);
    }
  } catch (error: any) {
    console.error('\n❌ TEST FAILED');
    console.error(`Fatal error: ${error.message}\n`);
    process.exit(1);
  }
}

runAutonomousAgent().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
