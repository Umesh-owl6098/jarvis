/**
 * Checkpoint 16 §16 — local deterministic navigation-evidence fixtures A-H.
 * A small hand-built HTTP server producing REAL status codes and redirects
 * (not just static-file 200/404) — Playwright's Response object is what's
 * under test, so the fixture has to actually exercise real transport
 * behavior, not simulate it.
 */

import { BrowserController } from '@/core/browser/controller';
import { NavigationSkill } from '@/skills/navigation';
import type { NavigationEvidence } from '@/core/browser/navigation-evidence';
import http from 'http';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

function startServer(port: number): Promise<() => Promise<void>> {
  const server = http.createServer((req, res) => {
    const url = req.url ?? '/';
    if (url === '/normal') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><title>Normal Page</title><body>Hello</body></html>');
    } else if (url === '/redirect-then-ok') {
      res.writeHead(302, { Location: '/normal' });
      res.end();
    } else if (url === '/missing') {
      res.writeHead(404, { 'Content-Type': 'text/html' });
      res.end('<html><title>Not Found</title><body>404</body></html>');
    } else if (url === '/broken') {
      res.writeHead(500, { 'Content-Type': 'text/html' });
      res.end('<html><title>Server Error</title><body>500</body></html>');
    } else if (url === '/old-canonical') {
      res.writeHead(301, { Location: '/normal' });
      res.end();
    } else if (url === '/redirect-to-error') {
      res.writeHead(302, { Location: '/missing' });
      res.end();
    } else if (url === '/looks-like-error-but-ok') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><title>Status Page</title><body>Error: the previous deployment failed, but this page is fine.</body></html>');
    } else {
      res.writeHead(404);
      res.end('not found');
    }
  });
  return new Promise((resolve) => { server.listen(port, () => resolve(() => new Promise((r) => server.close(() => r())))); });
}

async function navigateAndGetEvidence(browser: BrowserController, nav: NavigationSkill, url: string): Promise<{ success: boolean; error?: string; evidence?: NavigationEvidence }> {
  const result = await nav.execute({ url });
  return { success: result.success, error: result.error, evidence: result.result as NavigationEvidence | undefined };
}

async function main() {
  const port = 8970;
  const stopServer = await startServer(port);
  const browser = new BrowserController();
  await browser.initialize();
  const nav = new NavigationSkill(browser);

  try {
    // A. 200 normal page -> completed
    {
      const r = await navigateAndGetEvidence(browser, nav, `http://localhost:${port}/normal`);
      check(
        'A. 200 normal page: transport succeeds, no error detected',
        r.success && r.evidence?.httpStatus === 200 && r.evidence?.errorPageDetected === false,
        JSON.stringify(r.evidence)
      );
    }

    // B. 302 -> 200 -> completed, redirected=true
    {
      const r = await navigateAndGetEvidence(browser, nav, `http://localhost:${port}/redirect-then-ok`);
      check(
        'B. 302->200: redirected=true, final status 200, no error',
        r.success && r.evidence?.httpStatus === 200 && r.evidence?.redirected === true && r.evidence?.errorPageDetected === false,
        JSON.stringify(r.evidence)
      );
    }

    // C. 404 -> NOT completed (errorPageDetected true)
    {
      const r = await navigateAndGetEvidence(browser, nav, `http://localhost:${port}/missing`);
      check(
        'C. 404: transport succeeds but errorPageDetected=true (goal NOT satisfied)',
        r.success && r.evidence?.httpStatus === 404 && r.evidence?.errorPageDetected === true,
        JSON.stringify(r.evidence)
      );
    }

    // D. 500 -> NOT completed
    {
      const r = await navigateAndGetEvidence(browser, nav, `http://localhost:${port}/broken`);
      check(
        'D. 500: errorPageDetected=true',
        r.success && r.evidence?.httpStatus === 500 && r.evidence?.errorPageDetected === true,
        JSON.stringify(r.evidence)
      );
    }

    // F. valid redirect to canonical target -> completed, reachedRequestedOrigin true
    {
      const r = await navigateAndGetEvidence(browser, nav, `http://localhost:${port}/old-canonical`);
      check(
        'F. canonical redirect (same origin): reachedRequestedOrigin=true, not falsely failed',
        r.success && r.evidence?.reachedRequestedOrigin === true && r.evidence?.errorPageDetected === false,
        JSON.stringify(r.evidence)
      );
    }

    // G. redirect to an error page -> blocked/failed based on evidence
    {
      const r = await navigateAndGetEvidence(browser, nav, `http://localhost:${port}/redirect-to-error`);
      check(
        'G. redirect landing on a 404: errorPageDetected=true despite same-origin redirect',
        r.success && r.evidence?.redirected === true && r.evidence?.errorPageDetected === true,
        JSON.stringify(r.evidence)
      );
    }

    // E. connection refused -> failed. Run LAST — Chrome renders its own
    // internal chrome-error:// page for a connection failure, and that
    // page's own load can still be settling when the NEXT goto() call
    // starts, racing and "interrupting" it (observed directly: moving this
    // fixture earlier in the sequence made F/G/H fail with exactly that
    // Playwright error). Not a bug in NavigationEvidence itself — a
    // sequencing issue in reusing one page for 8 rapid navigations.
    {
      const r = await navigateAndGetEvidence(browser, nav, 'http://localhost:1/nonexistent');
      check(
        'E. connection refused: skill reports failure, evidence carries browserError',
        r.success === false && !!r.evidence?.browserError && r.evidence?.httpStatus === undefined,
        JSON.stringify(r.evidence) + ` error=${r.error}`
      );
      // Chrome's own internal chrome-error:// page render can still be
      // settling here — give it a moment before the next real navigation,
      // or that one races and gets reported as "interrupted."
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    // H. body contains "error" but HTTP 200 -> must NOT falsely fail
    {
      const r = await navigateAndGetEvidence(browser, nav, `http://localhost:${port}/looks-like-error-but-ok`);
      check(
        'H. page body contains "Error:" text but HTTP 200: errorPageDetected=false (evidence-only, not text-based)',
        r.success && r.evidence?.httpStatus === 200 && r.evidence?.errorPageDetected === false,
        JSON.stringify(r.evidence)
      );
    }
  } finally {
    await browser.close();
    await stopServer();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
