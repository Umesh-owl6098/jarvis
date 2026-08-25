/**
 * Checkpoint 9 — live-site test matrix, driven through the real UI exactly
 * as an operator would type it. Reuses the polling pattern from
 * test-command-matrix.ts (fill #jarvis-command, click Execute, poll PHASE).
 */

import { chromium, type Page } from 'playwright';

const BASE = 'http://localhost:3000?skipIntro=1';

const TASKS = [
  'open nike.com and select the least costly item',
  'open news.ycombinator.com and tell me the top story title',
  'Open wikipedia.org and search for OpenAI',
  'Search GitHub for React repositories',
  'Open example.com',
];

const field = (p: Page, src: string) =>
  p.evaluate((s) => {
    const m = document.body.innerText.match(new RegExp(s, 'm'));
    return m ? m[1].trim() : null;
  }, src);

async function runOne(page: Page, typed: string) {
  await page.waitForFunction(
    () => {
      const t = document.getElementById('jarvis-command') as HTMLTextAreaElement | null;
      return !!t && !t.disabled;
    },
    { timeout: 300000 }
  );
  const reset = page.locator('button', { hasText: 'Reset' }).first();
  if (await reset.count()) await reset.click().catch(() => {});
  await page.waitForTimeout(500);

  const start = Date.now();
  await page.fill('#jarvis-command', typed);
  await page.waitForTimeout(200);
  await page.locator('button', { hasText: 'Execute' }).first().click();

  const phase = await page
    .waitForFunction(
      () => {
        const m = document.body.innerText.match(/PHASE\n([^\n]+)/);
        const v = m ? m[1].trim() : '';
        return ['COMPLETED', 'FAILED', 'STOPPED'].includes(v) ? v : false;
      },
      undefined,
      { timeout: 300000 }
    )
    .then((h) => h.jsonValue() as Promise<string>)
    .catch(() => null);

  const durationS = ((Date.now() - start) / 1000).toFixed(1);
  await page.waitForTimeout(700);

  return {
    typed,
    phase,
    durationS,
    url: await field(page, '\\nURL\\n([^\\n]+)'),
    title: await field(page, 'DOCUMENT TITLE\\n([^\\n]+)'),
    steps: await field(page, 'STEPS\\n([^\\n]+)'),
    tokens: await field(page, 'TOKENS\\n([^\\n]+)'),
    result:
      (await field(page, 'RETURNED PAYLOAD\\n+([^\\n]+)')) ??
      (await field(page, 'FAULT REPORT\\n+([^\\n]+)')),
  };
}

async function main() {
  const browser = await chromium.launch({ channel: 'chrome' });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);

  for (const t of TASKS) {
    const row = await runOne(page, t);
    console.log(`\n${'='.repeat(72)}\n${JSON.stringify(row.typed)}`);
    console.log(`  phase    : ${row.phase}`);
    console.log(`  duration : ${row.durationS}s`);
    console.log(`  steps    : ${row.steps}`);
    console.log(`  tokens   : ${row.tokens}`);
    console.log(`  url      : ${row.url}`);
    console.log(`  title    : ${row.title}`);
    console.log(`  result   : ${String(row.result).slice(0, 220)}`);
  }

  await browser.close();
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
