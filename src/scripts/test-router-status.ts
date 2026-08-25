/**
 * Deterministic tests for router status classification and browser-lifecycle
 * recovery. No real provider is spammed to induce a 429 — outcomes are
 * recorded directly, which is what the client does anyway.
 */

import {
  routerRuntime,
  resolveRouterStatus,
  classifyGenerationFailure,
  TRANSIENT_TTL_MS,
} from '@/core/router/runtime-status';
import { BrowserController } from '@/core/browser/controller';
import { NavigationSkill } from '@/skills/navigation';
import { ObservationBuilder } from '@/core/observation';
import { describeError } from '@/core/browser/errors';

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

async function routerStatusTests() {
  console.log('\n=== Router status ===');

  routerRuntime.reset();
  check('CHECKING/unknown + reachable -> online', resolveRouterStatus(true, 'unknown') === 'online');

  routerRuntime.reset();
  routerRuntime.recordSuccess({ model: 'test-model', provider: 'test' });
  check(
    'REACHABLE + generation success -> ONLINE',
    resolveRouterStatus(true, routerRuntime.currentState()) === 'online',
    `state=${routerRuntime.currentState()}`
  );

  routerRuntime.reset();
  routerRuntime.recordFailure(429);
  check(
    'REACHABLE + 429 -> RATE LIMITED',
    resolveRouterStatus(true, routerRuntime.currentState()) === 'rate_limited',
    `state=${routerRuntime.currentState()}`
  );

  routerRuntime.reset();
  routerRuntime.recordFailure(503);
  check(
    'REACHABLE + 503 -> DEGRADED',
    resolveRouterStatus(true, routerRuntime.currentState()) === 'degraded',
    `state=${routerRuntime.currentState()}`
  );

  routerRuntime.reset();
  routerRuntime.recordFailure(429);
  check('UNREACHABLE -> OFFLINE (overrides generation)', resolveRouterStatus(false, 'rate_limited') === 'offline');

  // recovery: a success after a 429 must clear the amber state
  routerRuntime.reset();
  routerRuntime.recordFailure(429);
  const before = routerRuntime.currentState();
  routerRuntime.recordSuccess({ model: 'm', provider: 'p' });
  check(
    'RECOVERY 429 -> success -> ONLINE',
    before === 'rate_limited' && resolveRouterStatus(true, routerRuntime.currentState()) === 'online',
    `${before} -> ${routerRuntime.currentState()}`
  );

  // transient states age out on their own
  routerRuntime.reset();
  routerRuntime.recordFailure(429);
  const aged = routerRuntime.currentState(Date.now() + TRANSIENT_TTL_MS + 1000);
  check('transient 429 expires after TTL', aged === 'unknown', `aged=${aged}`);

  check(
    'connection failure (no status) classified unavailable',
    classifyGenerationFailure(undefined) === 'unavailable'
  );

  const snap = routerRuntime.snapshot();
  check(
    'snapshot exposes no secrets',
    !JSON.stringify(snap).match(/key|token|authorization|bearer/i),
    Object.keys(snap).join(',')
  );
}

async function browserLifecycleTests() {
  console.log('\n=== Browser lifecycle ===');

  /* --- closed page: observation must not blindly call page.title() --- */
  {
    const b = new BrowserController();
    await b.initialize();
    await b.goto('https://example.com');
    check('alive before close', b.isAlive() === true);

    await b.getPage()!.close();
    check('isAlive() false after page close', b.isAlive() === false);

    const live = b.livenessError();
    check('livenessError -> PAGE_CLOSED', live?.code === 'PAGE_CLOSED', String(live?.message));

    let code = 'NONE';
    let message = '';
    try {
      await ObservationBuilder.buildFromBrowser(b, 'observe a dead page');
    } catch (e) {
      const d = describeError(e);
      code = d.code;
      message = d.error;
    }
    check(
      'observing a closed page -> structured PAGE_CLOSED, no Playwright stack',
      (code === 'PAGE_CLOSED' || code === 'BROWSER_CLOSED') && !message.includes('page.title:'),
      `${code}: ${message}`
    );

    // context survived, so a page can be recovered without a new browser
    const recovered = await b.recoverPage();
    check('recoverPage() restores a usable page', recovered === true && b.isAlive() === true);

    const obs = await ObservationBuilder.buildFromBrowser(b, 'observe after recovery');
    check('observation works after recovery', obs.url === 'about:blank', `url=${obs.url}`);

    await b.close();
  }

  /* --- whole browser closed --- */
  {
    const b = new BrowserController();
    await b.initialize();
    await b.close();
    check('isAlive() false after browser close', b.isAlive() === false);
    const live = b.livenessError();
    check(
      'livenessError -> BROWSER_CLOSED/PAGE_CLOSED after full close',
      live?.code === 'BROWSER_CLOSED' || live?.code === 'PAGE_CLOSED',
      String(live?.code)
    );
    const recovered = await b.recoverPage();
    check('recoverPage() refuses when the browser is gone', recovered === false);
  }

  /* --- navigation failure must NOT kill the session --- */
  {
    const b = new BrowserController();
    await b.initialize();
    const nav = new NavigationSkill(b);

    // RFC-2606 reserved TLD: guaranteed not to resolve, safe to request.
    const out = await nav.execute({ url: 'https://this-host-does-not-exist.invalid' });
    check('unreachable host -> navigation reports failure', out.success === false, String(out.error).slice(0, 90));
    check('browser still alive after navigation failure', b.isAlive() === true);

    const obs = await ObservationBuilder.buildFromBrowser(b, 'after failed navigation');
    check('can still observe after navigation failure', typeof obs.url === 'string', `url=${obs.url}`);

    const ok = await nav.execute({ url: 'https://example.com' });
    check('can still navigate after a failed navigation', ok.success === true);

    await b.close();
  }
}

async function main() {
  await routerStatusTests();
  await browserLifecycleTests();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
