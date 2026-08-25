import { chromium } from 'playwright';

const BASE = 'http://localhost:3000?skipIntro=1';

const field = (p: any, src: string) =>
  p.evaluate((s: string) => {
    const m = document.body.innerText.match(new RegExp(s, 'm'));
    return m ? m[1].trim() : null;
  }, src);

async function main() {
  const browser = await chromium.launch({ channel: 'chrome' });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);

  const typed = 'open nike.com and select the least costly item';
  const start = Date.now();
  await page.fill('#jarvis-command', typed);
  await page.waitForTimeout(300);
  await page.locator('button', { hasText: 'Execute' }).first().click();

  const phase = await page
    .waitForFunction(
      () => {
        const m = document.body.innerText.match(/PHASE\n([^\n]+)/);
        const v = m ? m[1].trim() : '';
        return ['COMPLETED', 'FAILED', 'STOPPED'].includes(v) ? v : false;
      },
      undefined,
      { timeout: 300000, polling: 500 }
    )
    .then((h) => h.jsonValue())
    .catch((e) => `ERROR: ${e.message?.slice(0, 200)}`);

  const durationS = ((Date.now() - start) / 1000).toFixed(1);
  await page.waitForTimeout(1000);

  console.log('phase   :', phase);
  console.log('duration:', durationS + 's');
  console.log('url     :', await field(page, '\\nURL\\n([^\\n]+)'));
  console.log('title   :', await field(page, 'DOCUMENT TITLE\\n([^\\n]+)'));
  console.log('steps   :', await field(page, 'STEPS\\n([^\\n]+)'));
  console.log('tokens  :', await field(page, 'TOKENS\\n([^\\n]+)'));
  console.log(
    'result  :',
    (await field(page, 'RETURNED PAYLOAD\\n+([^\\n]+)')) ?? (await field(page, 'FAULT REPORT\\n+([^\\n]+)'))
  );

  await browser.close();
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
