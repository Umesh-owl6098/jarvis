/**
 * Deterministic Test: Execute AgentActions WITHOUT an LLM.
 *
 * This tests the entire execution pipeline:
 * AgentAction → Zod validation → ActionExecutor → Skill → Playwright
 *
 * Test flow:
 * 1. Navigate to example.com
 * 2. Observe page (build element registry)
 * 3. Extract title
 * 4. Finish
 *
 * No LLM involved. Pure action execution.
 */

import { BrowserController } from '@/core/browser/controller';
import { ElementRegistry } from '@/core/element-registry';
import { ActionExecutor } from '@/core/executor';
import { AgentAction, AgentActionSchema } from '@/core/action';

async function testDeterministicExecution() {
  console.log('🧪 Deterministic Execution Test (No LLM)\n');

  const browser = new BrowserController();
  const elementRegistry = new ElementRegistry();
  const executor = new ActionExecutor(browser, elementRegistry);

  try {
    // Step 1: Initialize browser
    console.log('📍 Step 1: Initialize browser');
    await browser.initialize();
    console.log('   ✅ Browser ready\n');

    // Step 2: Navigate
    console.log('📍 Step 2: Navigate to example.com');
    const navigateAction: AgentAction = {
      type: 'navigate',
      url: 'https://example.com',
    };

    // Validate action
    const validated1 = AgentActionSchema.parse(navigateAction);
    console.log(`   ✅ Action validated\n`);

    // Execute action
    const navResult = await executor.execute(navigateAction);
    if (!navResult.success) throw new Error(navResult.message);
    console.log(`   ✅ ${navResult.message}`);
    console.log(`   ℹ️  Elements found: ${(navResult.data as any)?.elementsFound}\n`);

    // Step 3: Build element registry
    console.log('📍 Step 3: Build element registry from page');
    const page = browser.getPage();
    if (!page) throw new Error('Page not available');

    await elementRegistry.buildFromPage(page);
    console.log(`   ✅ Registry built`);
    console.log(`   ℹ️  Total elements: ${elementRegistry.size()}`);

    // List elements for debugging
    const elements = elementRegistry.listElements();
    console.log(`   Elements:`);
    elements.forEach(el => {
      console.log(`     - ${el.id}: ${el.type} "${el.text || el.ariaLabel || '(no text)'}"`);
    });
    console.log();

    // Step 4: Extract visible text
    console.log('📍 Step 4: Extract page content');
    const extractAction: AgentAction = {
      type: 'extract',
    };

    const extractResult = await executor.execute(extractAction);
    if (!extractResult.success) throw new Error(extractResult.message);
    console.log(`   ✅ ${extractResult.message}`);
    console.log(`   Text preview: "${(extractResult.data as any)?.text?.substring(0, 100)}..."\n`);

    // Step 5: Finish
    console.log('📍 Step 5: Finish task');
    const finishAction: AgentAction = {
      type: 'finish',
      result: 'Successfully navigated to example.com and extracted content',
    };

    const finishResult = await executor.execute(finishAction);
    console.log(`   ✅ ${finishResult.message}\n`);

    // Summary
    console.log('━'.repeat(60));
    console.log('✅ DETERMINISTIC TEST PASSED\n');
    console.log('📊 Results:');
    console.log(`   • Actions executed: 4 (navigate, build-registry, extract, finish)`);
    console.log(`   • Elements discovered: ${elementRegistry.size()}`);
    console.log(`   • All actions successful: ✅`);
    console.log(`   • No LLM calls: ✅`);
    console.log('');

  } catch (error: any) {
    console.error('\n❌ TEST FAILED');
    console.error(`Error: ${error.message}\n`);
    process.exit(1);
  } finally {
    console.log('Cleaning up...');
    await browser.close();
    console.log('Done.\n');
  }
}

testDeterministicExecution().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
