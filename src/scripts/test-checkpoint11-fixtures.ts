/**
 * Checkpoint 11 — local deterministic fixtures for goal-progress/completion.
 *
 * Drives the REAL AgentExecutor (real OmniRoute calls where planning is
 * still needed) against local fixtures, pre-navigated directly since
 * bootstrap correctly does not handle file:// targets. Relies on
 * BrowserController.initialize() now being idempotent so pre-navigation
 * survives executor.execute()'s own initialize() call.
 */

import { BrowserController } from '@/core/browser/controller';
import { Planner } from '@/core/agent/planner';
import { AgentExecutor } from '@/core/agent/executor';
import { ContextManager } from '@/core/context';
import { SkillRegistry } from '@/skills/registry';
import { NavigationSkill } from '@/skills/navigation';
import { ExtractionSkill } from '@/skills/extraction';
import { InteractionSkill } from '@/skills/interaction';
import { SearchSkill } from '@/skills/search';
import { OmniRouteClient } from '@/core/router/client';
import { classifyGoal } from '@/core/agent/goal-state';
import path from 'path';
import http from 'http';
import { createReadStream } from 'fs';

/**
 * NavigationSkill correctly refuses file: URLs (only http/https are
 * allowed — a real, intentional safety boundary, not a bug). The executor's
 * href fallback goes through that same skill, so testing it needs a real
 * http origin, not file://. This is a plain static file server for the repo
 * root — test-only, never imported by runtime code.
 */
function startStaticServer(rootDir: string, port: number): Promise<() => Promise<void>> {
  const server = http.createServer((req, res) => {
    const filePath = path.join(rootDir, decodeURIComponent((req.url ?? '/').split('?')[0]));
    createReadStream(filePath)
      .on('error', () => {
        res.writeHead(404);
        res.end('not found');
      })
      .pipe(res);
  });
  return new Promise((resolve) => {
    server.listen(port, () => resolve(() => new Promise((r) => server.close(() => r()))));
  });
}

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    pass++;
    console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    fail++;
    console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function runFixture(task: string, fixtureFile?: string, fixtureUrl?: string) {
  const browser = new BrowserController();
  await browser.initialize();
  if (fixtureUrl) {
    await browser.goto(fixtureUrl);
  } else if (fixtureFile) {
    const url = `file://${path.join(process.cwd(), fixtureFile)}`;
    await browser.goto(url);
  }
  const context = new ContextManager(task);
  const skillRegistry = new SkillRegistry();
  skillRegistry.register(new NavigationSkill(browser));
  skillRegistry.register(new ExtractionSkill(browser));
  skillRegistry.register(new InteractionSkill(browser));
  skillRegistry.register(new SearchSkill(browser));
  const planner = new Planner(new OmniRouteClient(), skillRegistry, context);
  const executor = new AgentExecutor(browser, planner, context, skillRegistry, 8);
  return executor.execute(task);
}

async function main() {
  // H (classification only): ambiguous task never gets a deterministic label.
  const hClass = classifyGoal("figure out what's interesting on this page");
  check('H. ambiguous task classifies as unclassified', hClass.goalType === 'unclassified', JSON.stringify(hClass));

  // A: known page, deterministic completion, ZERO planner calls.
  {
    const r = await runFixture('Open example.com');
    check(
      'A. navigate goal completes deterministically with no planner call',
      r.status === 'success' && r.outcome === 'completed' && r.tokensUsed === 0,
      `status=${r.status} outcome=${r.outcome} tokensUsed=${r.tokensUsed} steps=${r.steps}`
    );
  }

  // B: top item from a plain list.
  {
    const r = await runFixture('open the top story', 'test-fixture-gs-stories.html');
    check(
      'B. navigate_to_target (top) reaches the first story and completes',
      r.status === 'success' && r.outcome === 'completed' && r.steps <= 3,
      `status=${r.status} outcome=${r.outcome} steps=${r.steps} result=${r.result.slice(0, 120)}`
    );
  }

  // C: cheapest item from a priced grid.
  {
    const r = await runFixture('select the least costly item', 'test-fixture-gs-products.html');
    check(
      'C. navigate_to_target (cheapest) commits Product B and completes',
      r.status === 'success' && r.outcome === 'completed' && /product b/i.test(r.result),
      `status=${r.status} outcome=${r.outcome} steps=${r.steps} result=${r.result.slice(0, 150)}`
    );
  }

  // D: primary click blocked, but a same-origin href on the SAME committed
  // target exists — executor-owned fallback should reach it without the
  // planner needing to decide to use it. Served over real http:// because
  // NavigationSkill correctly refuses file: URLs (a real safety boundary,
  // not something to route around) and the fallback goes through that skill.
  {
    const stopServer = await startStaticServer(process.cwd(), 8934);
    try {
      const r = await runFixture('open the cheapest item', undefined, 'http://localhost:8934/test-fixture-gs-deals.html');
      check(
        'D. blocked click on committed target recovers via href fallback and completes',
        r.status === 'success' && r.outcome === 'completed' && /deal a/i.test(r.result),
        `status=${r.status} outcome=${r.outcome} steps=${r.steps} result=${r.result.slice(0, 150)}`
      );
    } finally {
      await stopServer();
    }
  }

  // E: no navigate-back oscillation — folds into B/C/D above (steps<=3 and a
  // single 'completed' outcome IS the absence of oscillation; an oscillating
  // run would hit the step cap or the cycle guard instead).

  // F: navigate + extract — real site (classification requires a named
  // domain by design), confirms no false-early-finish: this MUST cost real
  // planner tokens, unlike A.
  {
    // Checkpoint 12 §11/§12 intentionally added a deterministic shortcut for
    // exactly this shape ("tell me the page title") — this assertion was
    // updated to match, it originally asserted the opposite (tokensUsed > 0)
    // when checkpoint 11 had no such shortcut yet. Still verifies the
    // *content* is correct, which is what actually matters here.
    const r = await runFixture('Open example.com and tell me the page title');
    check(
      'F. navigate_and_extract: simple title request short-circuits deterministically (checkpoint 12)',
      r.status === 'success' && r.tokensUsed === 0 && /Example Domain/i.test(r.result),
      `status=${r.status} outcome=${r.outcome} tokensUsed=${r.tokensUsed} result=${r.result.slice(0, 120)}`
    );
  }

  // G: search, then open the first result.
  {
    const r = await runFixture('search for the first result and open it', 'test-fixture-gs-search.html');
    check(
      'G. search_and_open: search milestone gates target commitment, reaches result, completes',
      r.status === 'success' && r.outcome === 'completed' && /first result/i.test(r.result),
      `status=${r.status} outcome=${r.outcome} steps=${r.steps} result=${r.result.slice(0, 150)}`
    );
  }

  // H (live): unclassified task must go through normal planning, not a shortcut.
  {
    const url = `file://${path.join(process.cwd(), 'test-fixture.html')}`;
    const browser = new BrowserController();
    await browser.initialize();
    await browser.goto(url);
    const context = new ContextManager('figure out what this page lets you do');
    const skillRegistry = new SkillRegistry();
    skillRegistry.register(new NavigationSkill(browser));
    skillRegistry.register(new ExtractionSkill(browser));
    skillRegistry.register(new InteractionSkill(browser));
    skillRegistry.register(new SearchSkill(browser));
    const planner = new Planner(new OmniRouteClient(), skillRegistry, context);
    const executor = new AgentExecutor(browser, planner, context, skillRegistry, 8);
    const r = await executor.execute('figure out what this page lets you do');
    check(
      'H. unclassified task never deterministically auto-finishes',
      r.tokensUsed > 0,
      `status=${r.status} outcome=${r.outcome} tokensUsed=${r.tokensUsed} steps=${r.steps}`
    );
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
