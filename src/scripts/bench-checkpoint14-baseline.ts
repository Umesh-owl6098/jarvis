/**
 * Checkpoint 14 §1 — baseline measurement of multi-step tasks through the
 * CURRENT (Checkpoint 13) system, before any TaskPlan/Subgoal work begins.
 * Establishes evidence for what actually needs improving.
 */

import { runTask } from '@/core/agent/task-manager';
import { BrowserController } from '@/core/browser/controller';
import path from 'path';
import http from 'http';
import { createReadStream } from 'fs';

function startStaticServer(rootDir: string, port: number): Promise<() => Promise<void>> {
  const server = http.createServer((req, res) => {
    const filePath = path.join(rootDir, decodeURIComponent((req.url ?? '/').split('?')[0]));
    createReadStream(filePath).on('error', () => { res.writeHead(404); res.end('not found'); }).pipe(res);
  });
  return new Promise((resolve) => { server.listen(port, () => resolve(() => new Promise((r) => server.close(() => r())))); });
}

function withLaunchCounter<T>(fn: () => Promise<T>): Promise<{ result: T; launches: number }> {
  // Counts real NEW Playwright launches, not every initialize() call — the
  // shared-browser subgoal path calls initialize() once per subgoal, but
  // the idempotent check (isAlive()) means only the FIRST actually spawns a
  // browser process; later calls just reuse it.
  let launches = 0;
  const orig = BrowserController.prototype.initialize;
  BrowserController.prototype.initialize = async function (this: BrowserController, ...args: any[]) {
    if (!this.isAlive()) launches++;
    return orig.apply(this, args as any);
  };
  return fn().then((result) => ({ result, launches })).finally(() => { BrowserController.prototype.initialize = orig; });
}

let plannerCalls = 0;
let inputTokens = 0;
let outputTokens = 0;
const origLog = console.log;
function countingLog(...args: any[]) {
  const line = args.join(' ');
  if (line.startsWith('[Planner] Attempt 1: Asking LLM')) plannerCalls++;
  const m = /\[OmniRoute\] Plan call: (\d+)in \+ (\d+)out/.exec(line);
  if (m) { inputTokens += Number(m[1]); outputTokens += Number(m[2]); }
  origLog(...args);
}

async function runOne(label: string, task: string) {
  plannerCalls = 0; inputTokens = 0; outputTokens = 0;
  const controller = new AbortController();
  const start = Date.now();
  console.log = countingLog;
  const { result, launches } = await withLaunchCounter(() => runTask({ goal: task, onEvent: () => {}, signal: controller.signal }));
  console.log = origLog;
  const durationS = ((Date.now() - start) / 1000).toFixed(1);
  console.log(
    `\n[BASELINE] ${label}: status=${result.status} outcome=${(result as any).outcome} ` +
      `capability=${result.capability?.selected} readAttempted=${result.capability?.readAttempted} browserFallback=${result.capability?.browserFallbackUsed} ` +
      `launches=${launches} plannerCalls=${plannerCalls} inTok=${inputTokens} outTok=${outputTokens} totalTok=${result.tokensUsed} ` +
      `steps=${result.steps} duration=${durationS}s`
  );
  console.log(`  result: ${result.result.slice(0, 220)}`);
  return { label, task, result, launches, plannerCalls, inputTokens, outputTokens, durationS };
}

async function main() {
  const port = 8950;
  const stopServer = await startStaticServer(process.cwd(), port);
  const rows: any[] = [];
  try {
    rows.push(await runOne('1. HN top story + open + title', 'Open Hacker News, find the top story, open it, and tell me the title.'));
    rows.push(await runOne('2. Wikipedia search + open + title', 'Open Wikipedia, search for OpenAI, open the result, and tell me the page title.'));
    rows.push(await runOne('3. GitHub React README purpose', 'Find the React GitHub repository and tell me what the README says it is for.'));
    rows.push(
      await runOne(
        '4. Local: cheapest deal -> open -> extract name',
        `open http://localhost:${port}/test-fixture-gs-deals.html, select the cheapest item, open it, and tell me the product name`
      )
    );
  } finally {
    await stopServer();
  }

  console.log(`\n${'='.repeat(70)}\nBASELINE SUMMARY\n${'='.repeat(70)}`);
  for (const r of rows) {
    console.log(
      `${r.label.padEnd(45)} status=${r.result.status.padEnd(8)} steps=${r.result.steps} launches=${r.launches} ` +
        `plannerCalls=${r.plannerCalls} tokens=${r.result.tokensUsed} duration=${r.durationS}s`
    );
  }
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
