/**
 * Checkpoint 11 — head-to-head planner benchmark: current default (hy3-free)
 * vs oc/nemotron-3-ultra-free, on the SAME JARVIS tasks, same temperature (0),
 * same executor/skill wiring as production (task-manager.ts's runTask()).
 *
 * Model is selected via JARVIS_PLANNER_MODELS (already-supported override in
 * planner-strategy.ts) — no code path is model-specific. Run twice:
 *   npx tsx src/scripts/bench-nemotron-vs-current.ts
 *   JARVIS_PLANNER_MODELS=oc/nemotron-3-ultra-free npx tsx src/scripts/bench-nemotron-vs-current.ts
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

const modelLabel = process.env.JARVIS_PLANNER_MODELS || '(default chain: oc/hy3-free)';

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

let schemaRetries = 0;
const origLog = console.log;
function countingLog(...args: any[]) {
  const line = args.join(' ');
  if (line.includes('No schema-valid JSON action found')) schemaRetries++;
  origLog(...args);
}

async function runTask(label: string, task: string) {
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
    `\n[${modelLabel}] ${label}: status=${result.status} outcome=${(result as any).outcome} ` +
      `steps=${result.steps} tokens=${result.tokensUsed} duration=${durationS}s schemaRetries=${schemaRetries}`
  );
  console.log(`  result: ${result.result.slice(0, 200)}`);
  return { label, status: result.status, outcome: (result as any).outcome, steps: result.steps, tokens: result.tokensUsed, durationS, schemaRetries };
}

async function main() {
  console.log(`\n${'='.repeat(70)}\nBENCHMARK — planner model: ${modelLabel}\n${'='.repeat(70)}`);
  const rows = [];
  const port = 8935;
  const stopServer = await startStaticServer(process.cwd(), port);

  try {
    rows.push(await runTask('A. Wikipedia search', 'Open wikipedia.org and search for OpenAI'));

    // B: local fixture standing in for "open the top story" — deterministic,
    // repeatable, no live-site load (live HN is covered separately). The URL
    // is embedded directly in the task text: bootstrap.ts's domain matcher
    // doesn't recognize "localhost", so the planner has to navigate itself
    // from the task text — an equally fair starting line for both models.
    rows.push(
      await runTask(
        'B. navigate_to_target (top)',
        `open http://localhost:${port}/test-fixture-gs-stories.html and open the top story`
      )
    );

    // C: local cheapest-item fixture (same one used for checkpoint 11's own C fixture)
    rows.push(
      await runTask(
        'C. cheapest item (local fixture)',
        `open http://localhost:${port}/test-fixture-gs-deals.html and select the cheapest item`
      )
    );

    // D: recovery scenario — occluded element from checkpoint 10's fixture
    rows.push(
      await runTask(
        'D. recovery (occluded element)',
        `open http://localhost:${port}/test-fixture-robustness.html and click the covered link`
      )
    );
  } finally {
    await stopServer();
  }

  console.log(`\n${'='.repeat(70)}\nSUMMARY — ${modelLabel}\n${'='.repeat(70)}`);
  for (const r of rows) {
    console.log(
      `${r.label.padEnd(35)} status=${r.status.padEnd(8)} outcome=${String(r.outcome).padEnd(10)} steps=${r.steps} tokens=${r.tokens} duration=${r.durationS}s schemaRetries=${r.schemaRetries}`
    );
  }
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
