/**
 * Checkpoint 9 — local fixture verification.
 *
 * Drives the REAL planner (real OmniRoute call, real ContentItem-aware
 * prompt) against a local static fixture with three plain-price product
 * cards. Bootstrap navigation deliberately does not handle file:// targets
 * (out of scope for this checkpoint — that is a navigation change, not a
 * content-understanding one), so this pre-navigates the browser directly,
 * exactly like the existing test-fixture-interaction.ts script does, then
 * drives a small manual observe/plan/act loop instead of AgentExecutor
 * (whose execute() unconditionally re-initializes the browser).
 */

import { BrowserController } from '@/core/browser/controller';
import { Planner } from '@/core/agent/planner';
import { ContextManager } from '@/core/context';
import { SkillRegistry } from '@/skills/registry';
import { NavigationSkill } from '@/skills/navigation';
import { ExtractionSkill } from '@/skills/extraction';
import { InteractionSkill } from '@/skills/interaction';
import { SearchSkill } from '@/skills/search';
import { OmniRouteClient } from '@/core/router/client';
import { ObservationBuilder } from '@/core/observation';
import path from 'path';

async function main() {
  const task = 'select the least costly item';
  const browser = new BrowserController();
  await browser.initialize();
  const fixtureUrl = `file://${path.join(process.cwd(), 'test-fixture-content.html')}`;
  await browser.goto(fixtureUrl);

  const context = new ContextManager(task);
  const skillRegistry = new SkillRegistry();
  skillRegistry.register(new NavigationSkill(browser));
  skillRegistry.register(new ExtractionSkill(browser));
  skillRegistry.register(new InteractionSkill(browser));
  skillRegistry.register(new SearchSkill(browser));
  const planner = new Planner(new OmniRouteClient(), skillRegistry, context);

  let tokens = 0;
  for (let step = 1; step <= 4; step++) {
    const obs = await ObservationBuilder.buildFromBrowser(browser, task);
    context.addObservation(obs);
    console.log(`\n--- step ${step} ---`);
    console.log(`contentItems sent: ${obs.contentItems.length} (withPrice=${obs.contentItemsWithPrice})`);
    console.log('top contentItems:', JSON.stringify(obs.contentItems.slice(0, 3)));

    const action = await planner.plan(obs);
    tokens = planner.getTokensUsed();
    console.log('planner action:', JSON.stringify(action));

    if (action.action === 'finish') {
      console.log(`\nFINISH: ${(action as any).result}`);
      break;
    }
    if (action.action === 'fail') {
      console.log(`\nFAIL: ${(action as any).reason}`);
      break;
    }
    if (action.action === 'use_skill') {
      const skill = skillRegistry.getSkill(action.skillId);
      if (!skill) {
        console.log(`unknown skill ${action.skillId}, stopping`);
        break;
      }
      const result = await skill.execute(action.input as any);
      context.logAction(`${action.skillId}(${JSON.stringify(action.input)})`, JSON.stringify(result).slice(0, 150));
      console.log('skill result:', JSON.stringify(result).slice(0, 200));
    }
  }

  console.log(`\ntotal planner tokens: ${tokens}`);
  await browser.close();
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
