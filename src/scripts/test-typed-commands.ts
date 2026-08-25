/**
 * Typed-command matrix through the real UI.
 *
 * Voice is irrelevant here — every command is typed into the command box and
 * submitted exactly as an operator would. Captures the directive the UI shows,
 * the browser subsystem URL/title, and the final result for each.
 */

import { chromium, type Page } from 'playwright';

const BASE = 'http://localhost:3000?skipIntro=1';

const COMMANDS = [
  'amazon.com',
  'Open amazon.com',
  'Open wikipedia.org',
  'Open github.com',
  'Open example.com',
  'Open wikipedia.org and search for OpenAI',
];

interface Row {
  command: string;
  directive: string | null;
  phase: string | null;
  url: string | null;
  title: string | null;
  result: string | null;
}

const field = (p: Page, src: string) =>
  p.evaluate((s) => {
    const m = document.body.innerText.match(new RegExp(s, 'm'));
    return m ? m[1].trim() : null;
  }, src);

async function run(page: Page, command: string): Promise<Row> {
  // Reset any previous task so nothing can be inherited.
  const reset = page.locator('button', { hasText: 'Reset' }).first();
  if (await reset.count()) await reset.click().catch(() => {});
  await page.waitForTimeout(400);

  await page.fill('#jarvis-command', command);
  await page.waitForTimeout(150);
  await page.locator('button', { hasText: 'Execute' }).first().click();

  const phase = await page
    .waitForFunction(
      () => {
        const m = document.body.innerText.match(/PHASE\n([^\n]+)/);
        const v = m ? m[1].trim() : '';
        return ['COMPLETED', 'FAILED', 'STOPPED'].includes(v) ? v : false;
      },
      { timeout: 180000 }
    )
    .then((h) => h.jsonValue() as Promise<string>)
    .catch(() => null);

  await page.waitForTimeout(600);

  return {
    command,
    directive: await field(page, 'DIRECTIVE\\n([^\\n]+)'),
    phase,
    url: await field(page, '\\nURL\\n([^\\n]+)'),
    title: await field(page, 'DOCUMENT TITLE\\n([^\\n]+)'),
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

  const rows: Row[] = [];
  for (const c of COMMANDS) {
    const row = await run(page, c);
    rows.push(row);
    const ok = row.phase === 'COMPLETED';
    console.log(`${ok ? '✅' : '⚠️ '} ${c}`);
    console.log(`     directive : ${row.directive}`);
    console.log(`     phase     : ${row.phase}`);
    console.log(`     url       : ${row.url}`);
    console.log(`     title     : ${row.title}`);
    console.log(`     result    : ${String(row.result).slice(0, 120)}`);
  }

  console.log('\n=== integrity: directive must equal the typed command ===');
  let bad = 0;
  for (const r of rows) {
    const match = r.directive === r.command;
    if (!match) bad++;
    console.log(`${match ? '✅' : '❌'} typed=${JSON.stringify(r.command)} directive=${JSON.stringify(r.directive)}`);
  }

  await browser.close();
  console.log(`\n${rows.length - bad}/${rows.length} directives matched the typed command`);
  if (bad > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
