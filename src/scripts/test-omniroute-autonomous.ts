/**
 * Real OmniRoute Autonomous Agent Test
 *
 * Uses the actual OmniRoute server (localhost:20128) instead of mock.
 * Tests the complete agent loop with real LLM routing.
 *
 * Prerequisites:
 * - OmniRoute server running on localhost:20128
 * - npm run start:omniroute in another terminal
 */

import { BrowserController } from '@/core/browser/controller';
import { Planner } from '@/core/agent/planner';
import { AgentExecutor } from '@/core/agent/executor';
import { ContextManager } from '@/core/context';
import { SkillRegistry } from '@/skills/registry';
import { NavigationSkill } from '@/skills/navigation';
import { ExtractionSkill } from '@/skills/extraction';
import { InteractionSkill } from '@/skills/interaction';
import { OmniRouteClient } from '@/core/router/client';

async function testRealOmniRoute() {
  console.log('\n🤖 JARVIS Real OmniRoute Autonomous Agent Test\n');
  console.log('📋 Task: "Open example.com and tell me the page title"\n');
  console.log('🔌 Router: REAL OmniRoute (http://localhost:20128)\n');
  console.log('━'.repeat(70));

  // Initialize with real OmniRoute
  const omniRoute = new OmniRouteClient(
    process.env.OMNIROUTE_BASE_URL || 'http://localhost:20128',
    process.env.OMNIROUTE_API_KEY
  );

  // Verify OmniRoute is available
  console.log('\n[Router] Checking OmniRoute health...');
  const isHealthy = await omniRoute.healthCheck();
  if (!isHealthy) {
    console.error('❌ OmniRoute server not available at http://localhost:20128');
    console.error('   Start it with: npx omniroute serve');
    process.exit(1);
  }
  console.log('[Router] ✅ OmniRoute is healthy\n');

  const browser = new BrowserController();
  const context = new ContextManager('Open example.com and tell me the page title');
  const skillRegistry = new SkillRegistry();
  const planner = new Planner(omniRoute, skillRegistry, context);
  const executor = new AgentExecutor(browser, planner, context, skillRegistry, 10);

  // Register skills
  skillRegistry.register(new NavigationSkill(browser));
  skillRegistry.register(new ExtractionSkill(browser));
  skillRegistry.register(new InteractionSkill(browser));

  try {
    const startTime = Date.now();
    const result = await executor.execute('Open example.com and tell me the page title');
    const duration = Date.now() - startTime;

    console.log('\n' + '━'.repeat(70));
    console.log('✅ REAL OMNIROUTE TEST COMPLETED\n');
    console.log('📊 Execution Results:');
    console.log(`   • Task ID: ${result.taskId}`);
    console.log(`   • Status: ${result.status}`);
    console.log(`   • Steps: ${result.steps}`);
    console.log(`   • Duration: ${duration}ms`);
    console.log(`   • LLM Calls: ${result.steps}+ (planning calls)`);
    console.log(`   • Tokens used: ${result.tokensUsed}`);
    console.log(`   • Result: ${result.result}`);
    console.log(`   • Actions executed: ${result.actions.join(' → ')}`);
    console.log('');

    if (result.status === 'success') {
      console.log('✅ REAL OMNIROUTE AUTONOMOUS TEST PASSED\n');
      process.exit(0);
    } else {
      console.log('❌ REAL OMNIROUTE AUTONOMOUS TEST FAILED\n');
      console.log(`Error: ${result.error}\n`);
      process.exit(1);
    }
  } catch (error: any) {
    console.error('\n❌ TEST FAILED');
    console.error(`Fatal error: ${error.message}\n`);
    if (error.message.includes('ECONNREFUSED')) {
      console.error('💡 OmniRoute server not running. Start with: npx omniroute serve\n');
    }
    process.exit(1);
  }
}

testRealOmniRoute().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
