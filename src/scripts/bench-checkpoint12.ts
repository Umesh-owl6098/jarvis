/**
 * Checkpoint 12 — fixed benchmark suite (BEFORE/AFTER context-optimization
 * comparison). Same 8 tasks, same executor/skill wiring as production
 * (task-manager.ts's runTask()), run twice against this file: once before
 * the compression changes, once after — see bench-*-before.log / -after.log.
 */

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
import path from 'path';
import http from 'http';
import { createReadStream } from 'fs';

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

let plannerCalls = 0;
let schemaRetries = 0;
const origLog = console.log;
function countingLog(...args: any[]) {
  const line = args.join(' ');
  if (line.startsWith('[Planner] Attempt 1: Asking LLM')) plannerCalls++;
  if (line.includes('No schema-valid JSON action found')) schemaRetries++;
  origLog(...args);
}

async function runTask(label: string, task: string) {
  plannerCalls = 0;
  schemaRetries = 0;
  const browser = new BrowserController();
  const context = new ContextManager(task);
  const skillRegistry = new SkillRegistry();
  const omniRoute = new OmniRouteClient();
  skillRegistry.register(new NavigationSkill(browser));
  skillRegistry.register(new ExtractionSkill(browser));
  skillRegistry.register(new InteractionSkill(browser));
  skillRegistry.register(new SearchSkill(browser));
  const planner = new Planner(omniRoute, skillRegistry, context);
  const executor = new AgentExecutor(browser, planner, context, skillRegistry, 10);

  console.log = countingLog;
  const start = Date.now();
  const result = await executor.execute(task);
  console.log = origLog;
  const durationS = ((Date.now() - start) / 1000).toFixed(1);

  console.log(
    `\n[RESULT] ${label}: status=${result.status} outcome=${(result as any).outcome} ` +
      `steps=${result.steps} plannerCalls=${plannerCalls} tokens=${result.tokensUsed} ` +
      `duration=${durationS}s schemaRetries=${schemaRetries}`
  );
  console.log(`  result: ${result.result.slice(0, 200)}`);
  return { label, status: result.status, steps: result.steps, plannerCalls, tokens: result.tokensUsed, durationS, schemaRetries };
}

async function main() {
  const port = 8936;
  const stopServer = await startStaticServer(process.cwd(), port);
  const rows = [];

  try {
    rows.push(await runTask('A. Open example.com', 'Open example.com'));

    rows.push(await runTask('B. Wikipedia title extraction', 'Open wikipedia.org and tell me the page title'));

    rows.push(await runTask('C. Wikipedia search', 'Open wikipedia.org and search for OpenAI'));

    rows.push(
      await runTask(
        'D. HN top story (local fixture)',
        `open http://localhost:${port}/test-fixture-gs-stories.html and open the top story`
      )
    );

    rows.push(
      await runTask(
        'E. Cheapest product (local fixture)',
        `open http://localhost:${port}/test-fixture-gs-deals.html and select the cheapest item`
      )
    );

    // F (live Nike) is run separately/manually — do not hammer the live site
    // on every benchmark iteration; see the report for the live-site numbers.

    rows.push(
      await runTask(
        'G. Recovery (occluded element)',
        `open http://localhost:${port}/test-fixture-robustness.html and click the covered link`
      )
    );

    rows.push(
      await runTask(
        'H. Unclassified/ambiguous',
        `open http://localhost:${port}/test-fixture-gs-about.html and figure out what this page lets you do`
      )
    );
  } finally {
    await stopServer();
  }

  console.log(`\n${'='.repeat(70)}\nSUMMARY\n${'='.repeat(70)}`);
  for (const r of rows) {
    console.log(
      `${r.label.padEnd(38)} status=${r.status.padEnd(8)} steps=${r.steps} plannerCalls=${r.plannerCalls} tokens=${r.tokens} duration=${r.durationS}s schemaRetries=${r.schemaRetries}`
    );
  }
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
