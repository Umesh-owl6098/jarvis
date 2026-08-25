/**
 * Integration Test: Full agent flow without OmniRoute
 *
 * Test Task: "Open example.com and tell me the page title"
 *
 * Flow:
 * 1. Initialize browser
 * 2. Observe (get page state)
 * 3. Execute action (navigate)
 * 4. Observe again
 * 5. Extract title
 * 6. Report result
 */

import { BrowserController } from '@/core/browser/controller';
import { ContextManager } from '@/core/context';
import { SkillRegistry } from '@/skills/registry';
import { NavigationSkill } from '@/skills/navigation';
import { ExtractionSkill } from '@/skills/extraction';
import { ObservationBuilder } from '@/core/observation';

async function runTest() {
  console.log('🧪 JARVIS Agent Integration Test\n');
  console.log('📋 Task: "Open example.com and tell me the page title"\n');

  const browser = new BrowserController();
  const context = new ContextManager('Open example.com and tell me the page title');
  const skillRegistry = new SkillRegistry();

  // Register skills
  skillRegistry.register(new NavigationSkill(browser));
  skillRegistry.register(new ExtractionSkill(browser));

  console.log('✓ Skills registered:', skillRegistry.listSkills().join(', '));
  console.log('');

  try {
    // Initialize browser
    console.log('📍 Step 1: Initialize browser');
    await browser.initialize();
    console.log('   ✅ Browser ready\n');

    // Navigate to example.com
    console.log('📍 Step 2: Navigate to example.com');
    const navSkill = skillRegistry.getSkill('navigation') as NavigationSkill;
    if (!navSkill) throw new Error('Navigation skill not found');

    const navResult = await navSkill.execute({ url: 'https://example.com' });
    if (!navResult.success) throw new Error(navResult.error);
    console.log(`   ✅ Navigated to example.com\n`);

    // Get observation
    console.log('📍 Step 3: Observe page state');
    const observation = await ObservationBuilder.buildFromBrowser(
      browser,
      'Open example.com and tell me the page title',
    );
    context.addObservation(observation);
    console.log(`   URL: ${observation.url}`);
    console.log(`   Title: ${observation.title}`);
    console.log(`   Text length: ${observation.textLength} chars`);
    console.log(`   Elements found: ${observation.interactiveElements.length}\n`);

    // Extract title
    console.log('📍 Step 4: Extract page title');
    const extractSkill = skillRegistry.getSkill('extraction') as ExtractionSkill;
    if (!extractSkill) throw new Error('Extraction skill not found');

    const titleResult = await extractSkill.execute({ type: 'title' });
    if (!titleResult.success) throw new Error(titleResult.error);
    console.log(`   ✅ Title extracted: "${(titleResult.result as any)?.title}"\n`);

    // Report result
    console.log('📍 Step 5: Task complete');
    console.log('\n✅ TEST PASSED\n');
    console.log('📊 Results:');
    console.log(`   • Task: Open example.com and tell me the page title`);
    console.log(`   • Page Title: "${observation.title}"`);
    console.log(`   • Page URL: ${observation.url}`);
    console.log(`   • Steps completed: 4`);
    console.log(`   • Tokens used: ~${context.estimateTokens(JSON.stringify(observation))}`);
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

runTest().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
