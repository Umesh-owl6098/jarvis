/**
 * Debug Script: Reproduce about:blank failure
 *
 * This captures:
 * - Exact planner inputs (observation + context)
 * - Planner outputs (action + reasoning)
 * - Why navigation isn't chosen on about:blank
 *
 * Task: "Open example.com and tell me the page title"
 * Expected: navigate → observe → extract → finish
 * Actual: extract loop on about:blank
 */

import { BrowserController } from '@/core/browser/controller';
import { ContextManager } from '@/core/context';
import { SkillRegistry } from '@/skills/registry';
import { NavigationSkill } from '@/skills/navigation';
import { ExtractionSkill } from '@/skills/extraction';
import { InteractionSkill } from '@/skills/interaction';
import { Planner } from '@/core/agent/planner';
import { OmniRouteClient } from '@/core/router/client';
import { ObservationBuilder } from '@/core/observation';

async function debugAboutBlank() {
  console.log('🔍 Debugging about:blank failure\n');
  console.log('Task: "Open example.com and tell me the page title"\n');

  const browser = new BrowserController();
  const goal = 'Open example.com and tell me the page title';
  const context = new ContextManager(goal);
  const skillRegistry = new SkillRegistry();
  const omniRoute = new OmniRouteClient();

  // Register skills
  skillRegistry.register(new NavigationSkill(browser));
  skillRegistry.register(new ExtractionSkill(browser));
  skillRegistry.register(new InteractionSkill(browser));

  try {
    // Initialize browser (starts on about:blank)
    await browser.initialize();
    const url = await browser.getURL();
    console.log(`📍 Browser initialized at: ${url}\n`);

    if (url !== 'about:blank') {
      console.log('⚠️  WARNING: Browser not at about:blank, test may not reproduce the issue\n');
    }

    // Create planner
    const planner = new Planner(omniRoute, skillRegistry, context);

    // Step 1: Observe blank page
    console.log('--- Step 1: Observe blank page ---');
    const obs1 = await ObservationBuilder.buildFromBrowser(browser, goal);

    console.log('\n📊 OBSERVATION 1:');
    console.log(`   URL: ${obs1.url}`);
    console.log(`   Title: "${obs1.title}"`);
    console.log(`   Text length: ${obs1.textLength}`);
    console.log(`   Elements: ${obs1.interactiveElements.length}`);
    console.log(`   Fingerprint: ${obs1.stateFingerprint}\n`);

    // Build what planner will see
    console.log('📋 PLANNER INPUT (Step 1):');
    console.log(`   Task: "${goal}"`);
    console.log(`   Current URL: ${obs1.url}`);
    console.log(`   Current Title: "${obs1.title}"`);
    console.log(`   Available skills: ${skillRegistry.listSkills().join(', ')}`);
    console.log();

    // Step 2: Call planner
    console.log('--- Step 2: Ask planner what to do ---');
    // Add observation to context for planner
    context.addObservation(obs1);
    console.log(`Planner context: ${context.getContextForLLM()}\n`);
    try {
      const action1 = await planner.plan(obs1);

      console.log('🧠 PLANNER OUTPUT (Step 1):');
      console.log(`   Action: ${action1.action}`);
      if (action1.action === 'use_skill') {
        console.log(`   Skill: ${(action1 as any).skillId}`);
        console.log(`   Input: ${JSON.stringify((action1 as any).input)}`);
        console.log(`   Reasoning: ${(action1 as any).reasoning}`);
      }
      console.log();

      // Check if this is the bad choice (extraction on about:blank)
      if (action1.action === 'use_skill' && (action1 as any).skillId === 'extraction') {
        console.log('❌ PROBLEM IDENTIFIED:');
        console.log('   Planner chose EXTRACTION while URL is about:blank');
        console.log('   Should have chosen NAVIGATION first\n');
        console.log('Why might this happen?');
        console.log('   1. Planner prompt not clear about initial state');
        console.log('   2. Task description not emphasized');
        console.log('   3. Context missing information about required navigation\n');
      }

      // If navigation was chosen correctly, follow through
      if (action1.action === 'use_skill' && (action1 as any).skillId === 'navigation') {
        console.log('✅ CORRECT: Planner chose NAVIGATION\n');

        // Execute navigation
        const navSkill = skillRegistry.getSkill('navigation') as NavigationSkill;
        const navResult = await navSkill.execute({ url: 'https://example.com' });
        console.log(`Navigation result: ${navResult.success ? '✅' : '❌'}\n`);

        if (navResult.success) {
          // Observe after navigation
          console.log('--- Step 3: Observe after navigation ---');
          const obs2 = await ObservationBuilder.buildFromBrowser(browser, goal);
          console.log(`   URL: ${obs2.url}`);
          console.log(`   Title: "${obs2.title}"`);
          console.log(`   Elements: ${obs2.interactiveElements.length}\n`);

          // Add observation to context (important!)
          context.addObservation(obs2);
          console.log('📋 PLANNER INPUT (Step 2):');
          console.log(`   Context: ${context.getContextForLLM()}\n`);

          // Plan next action
          const action2 = await planner.plan(obs2);
          console.log('--- Step 4: Plan next action ---');
          console.log(`   Action: ${action2.action}`);
          if (action2.action === 'use_skill') {
            console.log(`   Skill: ${(action2 as any).skillId}`);
            console.log(`   Input: ${JSON.stringify((action2 as any).input)}`);
            console.log(`   Reasoning: ${(action2 as any).reasoning}`);

            if ((action2 as any).skillId === 'navigation') {
              console.log('\n❌ PROBLEM: Planner chose navigation again!');
              console.log('   After navigation to example.com, it should:');
              console.log('   - Extract the page title, OR');
              console.log('   - Finish the task\n');
              console.log('   Not navigate again.\n');
            }
          }
        }
      }
    } catch (error: any) {
      console.error('❌ Planner error:', error.message);
      console.log('\nError suggests:');
      console.log('   - Malformed JSON from model');
      console.log('   - Schema validation failure');
      console.log('   - Model hallucinated non-existent skill\n');
    }

  } catch (error: any) {
    console.error('Fatal error:', error.message);
  } finally {
    await browser.close();
  }
}

debugAboutBlank().catch(console.error);
