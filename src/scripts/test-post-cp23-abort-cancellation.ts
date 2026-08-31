/**
 * Post-CP23 fix — Part D/E: the planner's HTTP call to OmniRoute never
 * received the task's AbortSignal at all (dropped between executor.ts's
 * `plan()` and OmniRouteClient.generate()'s raw axios.post()). Pressing
 * Abort only took effect at the NEXT `signal.throwIfAborted()` checkpoint
 * — after the in-flight request (and up to 3 retries, each up to the 60s
 * axios timeout, across up to 2 chained models) finished on its own. This
 * is the real root cause of the ~121s stall observed in the real UI: not a
 * deliberate delay, but an uncancellable request stacked behind normal
 * retry/backoff/fallback logic.
 *
 * These tests point OmniRouteClient at a local HTTP server that never
 * responds (deterministically slow, no real network dependency, no real
 * OmniRoute service needed) and prove: (1) an abort rejects almost
 * immediately, not after any timeout; (2) the rejection carries
 * `name === 'AbortError'`, which is what lets executor.ts report a clean
 * "stopped" result instead of a generic "failed" one; (3) a cancellation
 * is never retried.
 */
import http from 'http';
import { OmniRouteClient } from '@/core/router/client';
import { BrowserController } from '@/core/browser/controller';
import { AgentExecutor } from '@/core/agent/executor';
import { Planner } from '@/core/agent/planner';
import { ContextManager } from '@/core/context';
import { SkillRegistry } from '@/skills/registry';
import { NavigationSkill } from '@/skills/navigation';
import { ExtractionSkill } from '@/skills/extraction';
import { InteractionSkill } from '@/skills/interaction';
import { SearchSkill } from '@/skills/search';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

/** A server that accepts the connection but never writes a response — simulates a hung/slow OmniRoute upstream deterministically, no real network dependency. */
function startHangingServer(): Promise<{ url: string; requestCount: () => number; close: () => Promise<void> }> {
  let requestCount = 0;
  const server = http.createServer((_req, _res) => {
    requestCount++;
    // Deliberately never respond — the client's own timeout/abort is what's under test.
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        requestCount: () => requestCount,
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}

async function main() {
  // ---------- 1. Abort during an in-flight generate() call rejects almost immediately, not after any timeout ----------
  {
    const { url, requestCount, close } = await startHangingServer();
    const client = new OmniRouteClient(url, 'test-key');
    const controller = new AbortController();
    const start = Date.now();
    setTimeout(() => controller.abort(), 150);

    let caught: any = null;
    try {
      await client.generate({ messages: [{ role: 'user', content: 'hi' }] }, controller.signal);
    } catch (e) {
      caught = e;
    }
    const elapsed = Date.now() - start;
    check(
      '1a. an abort fired mid-request rejects the call — request actually received by the server first',
      requestCount() >= 1,
      `requestCount=${requestCount()}`
    );
    check(
      '1b. rejection happens quickly (well under the 60s axios timeout) — proves the signal actually reached the HTTP layer',
      elapsed < 5000,
      `elapsed=${elapsed}ms`
    );
    check('1c. the rejection carries name="AbortError" — what executor.ts depends on to report a clean "stopped" result', caught?.name === 'AbortError', `caught=${caught?.name}: ${caught?.message}`);
    await close();
  }

  // ---------- 2. A cancellation is never retried ----------
  {
    const { url, requestCount, close } = await startHangingServer();
    const client = new OmniRouteClient(url, 'test-key');
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 150);

    try {
      await client.generate({ messages: [{ role: 'user', content: 'hi' }] }, controller.signal);
    } catch {}
    // Give any (incorrect) retry attempt a moment to have started if the fix were absent.
    await new Promise((r) => setTimeout(r, 500));
    check(
      '2. exactly one request was ever sent — abort never triggers a retry (a retry would show requestCount > 1)',
      requestCount() === 1,
      `requestCount=${requestCount()}`
    );
    await close();
  }

  // ---------- 3. generateForPlanning() also honors the signal and does not fall back to the next model after a cancel ----------
  {
    const { url, requestCount, close } = await startHangingServer();
    const client = new OmniRouteClient(url, 'test-key');
    const controller = new AbortController();
    const start = Date.now();
    setTimeout(() => controller.abort(), 150);

    let caught: any = null;
    try {
      await client.generateForPlanning({ messages: [{ role: 'user', content: 'hi' }] }, controller.signal);
    } catch (e) {
      caught = e;
    }
    const elapsed = Date.now() - start;
    check('3a. generateForPlanning() rejects quickly on abort', elapsed < 5000, `elapsed=${elapsed}ms`);
    check('3b. rejection carries name="AbortError"', caught?.name === 'AbortError', `caught=${caught?.name}`);
    // PLANNER_MODEL_CHAIN defaults to 2 models; a correct fix stops at the
    // first one instead of trying the second after a deliberate cancel.
    await new Promise((r) => setTimeout(r, 500));
    check('3c. did not fall through to a second chained model after the cancel (at most 1 request sent)', requestCount() <= 1, `requestCount=${requestCount()}`);
    await close();
  }

  // ---------- 4. A signal that is ALREADY aborted before the call starts rejects synchronously, without ever hitting the network ----------
  {
    const { url, requestCount, close } = await startHangingServer();
    const client = new OmniRouteClient(url, 'test-key');
    const controller = new AbortController();
    controller.abort();

    let caught: any = null;
    try {
      await client.generate({ messages: [{ role: 'user', content: 'hi' }] }, controller.signal);
    } catch (e) {
      caught = e;
    }
    check('4a. an already-aborted signal rejects with name="AbortError"', caught?.name === 'AbortError', `caught=${caught?.name}`);
    check('4b. the request never reaches the network at all', requestCount() === 0, `requestCount=${requestCount()}`);
    await close();
  }

  // ---------- 5. Full end-to-end: real AgentExecutor + real Planner + real BrowserController, same wiring task-manager.ts's runBrowserTask() uses in production ----------
  {
    const { url, close } = await startHangingServer();
    const browser = new BrowserController();
    const context = new ContextManager('Open example.com and search the page for something');
    const skillRegistry = new SkillRegistry();
    skillRegistry.register(new NavigationSkill(browser));
    skillRegistry.register(new ExtractionSkill(browser));
    skillRegistry.register(new InteractionSkill(browser));
    skillRegistry.register(new SearchSkill(browser));
    const omniRoute = new OmniRouteClient(url, 'test-key'); // points the REAL planner at the hanging local server, not the real OmniRoute service
    const planner = new Planner(omniRoute, skillRegistry, context);
    const executor = new AgentExecutor(browser, planner, context, skillRegistry, 10);

    let closeCalled = false;
    const originalClose = browser.close.bind(browser);
    browser.close = async () => { closeCalled = true; await originalClose(); };

    const controller = new AbortController();
    let abortFiredAt = 0;
    // Fires once the task has actually reached the planning stage (bootstrap
    // navigation done, first "asking LLM" HTTP call in flight against the
    // hanging server) — proven by the 'agent.planning' event below, not a
    // guessed delay.
    const unsubscribe = executor.getEventCollector().subscribe((event) => {
      if (event.type === 'agent.planning' && abortFiredAt === 0) {
        abortFiredAt = Date.now();
        controller.abort();
      }
    });

    const overallStart = Date.now();
    let result;
    try {
      result = await executor.execute('Open example.com and search the page for something', controller.signal, 'test-abort-e2e');
    } finally {
      unsubscribe();
    }
    const totalElapsed = Date.now() - overallStart;
    const cancellationLatency = abortFiredAt > 0 ? Date.now() - abortFiredAt : -1;

    check('5a. the real planning stage was actually reached before abort fired (proves this exercised the live HTTP call, not a no-op)', abortFiredAt > 0);
    check('5b. execute() resolves (does not hang) — total elapsed well under the 60s axios timeout / minutes-long stall this fix addresses', totalElapsed < 15000, `totalElapsed=${totalElapsed}ms`);
    check('5c. cancellation latency (abort fired -> execute() resolved) is small — proves the signal reached the in-flight request, not just the next checkpoint after it', cancellationLatency < 5000, `cancellationLatency=${cancellationLatency}ms`);
    check('5d. task resolves in the clean "stopped" terminal state, not "failed"', result.status === 'stopped', `status=${result.status} result=${result.result}`);
    check('5e. BrowserController.close() was actually called — cleanup happens even when cancelled mid-plan', closeCalled);
    await close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(1);
});
