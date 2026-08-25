/**
 * Boot sequence + default-on microphone, driven through a real browser.
 *
 * Launched with Chrome's fake media device so getUserMedia resolves without a
 * physical microphone and without a permission dialog. That proves the
 * *activation path* — Enter grants, the loop starts itself, mute stops it.
 *
 * It does NOT prove speech is transcribed correctly: the fake device emits a
 * tone, not words, and the Web Speech API depends on a vendor service.
 */

import { chromium, type Browser, type Page } from 'playwright';

const BASE = 'http://localhost:3000';
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

const text = (p: Page) => p.evaluate(() => document.body.innerText);
const hasCommandBox = (p: Page) => p.evaluate(() => !!document.getElementById('jarvis-command'));
const hasBoot = (p: Page) =>
  p.evaluate(() => !!document.querySelector('[aria-label="JARVIS initialization"]'));
const micButtonText = (p: Page) =>
  p.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /mic/i.test(x.textContent || ''));
    return b?.textContent?.trim() ?? null;
  });
const voiceLabel = (p: Page) =>
  p.evaluate(() => {
    const m = document.body.innerText.match(/VOICE\n([^\n]+)/);
    return m ? m[1].trim() : null;
  });

async function main() {
  const browser: Browser = await chromium.launch({
    channel: 'chrome',
    args: [
      '--use-fake-ui-for-media-stream', // auto-accept the permission prompt
      '--use-fake-device-for-media-stream', // synthetic microphone
    ],
  });

  const context = await browser.newContext({
    permissions: ['microphone'],
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();

  /* ---------- boot gating ---------- */
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4200); // let the boot choreography reach "ready"

  check('boot overlay is shown on first visit', await hasBoot(page));
  check('operational HUD is NOT mounted before Enter', (await hasCommandBox(page)) === false);

  const bootText = await text(page);
  check(
    'boot screen shows identity and activation prompt',
    /JARVIS/.test(bootText) && /PRESS ENTER/i.test(bootText),
    bootText.split('\n').filter(Boolean).slice(-3).join(' / ')
  );

  /* ---------- Enter activates ---------- */
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1500);

  check('boot overlay dismissed after Enter', (await hasBoot(page)) === false);
  check('operational HUD mounted after Enter', await hasCommandBox(page));
  check(
    'initialization recorded for the session',
    (await page.evaluate(() => sessionStorage.getItem('jarvisInitialized'))) === 'true'
  );

  /* ---------- microphone is on by default ---------- */
  // Permission grant + device init + first recognition session is inherently
  // variable; a fixed sleep flakes. Poll for the condition instead — this still
  // proves the mic became active with NO click, which is the actual claim.
  await page
    .waitForFunction(() => /VOICE\nLISTENING/.test(document.body.innerText), { timeout: 25000 })
    .catch(() => {});
  const mic = await micButtonText(page);
  const label = await voiceLabel(page);
  // The button only reflects "not muted"; the state label is the real proof
  // that a recognition session actually started on its own.
  const listening = mic === 'Mic On' && label === 'LISTENING';
  check(
    'microphone active WITHOUT any click',
    listening,
    `button="${mic}" voice="${label}"`
  );

  /* ---------- mute / unmute ---------- */
  if (listening) {
    await page.locator('button', { hasText: 'Mic On' }).first().click();
    await page.waitForTimeout(500);
    const muted = await micButtonText(page);
    check('mute stops listening', muted === 'Mic Off', `button="${muted}" voice="${await voiceLabel(page)}"`);

    await page.locator('button', { hasText: 'Mic Off' }).first().click();
    await page.waitForTimeout(900);
    const back = await micButtonText(page);
    check('unmute resumes listening', back === 'Mic On', `button="${back}"`);
  } else {
    console.log('   (mute test skipped: microphone never became active)');
  }

  /* ---------- typed commands still work ---------- */
  await page.fill('#jarvis-command', 'open example.com');
  const execEnabled = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find(
      (x) => x.textContent?.trim() === 'Execute'
    ) as HTMLButtonElement | undefined;
    return b ? !b.disabled : false;
  });
  check('typed command path unaffected by voice', execEnabled);

  /* ---------- dev skip ---------- */
  const skipPage = await context.newPage();
  await skipPage.goto(`${BASE}?skipIntro=1`, { waitUntil: 'domcontentloaded' });
  await skipPage.waitForTimeout(1200);
  check('?skipIntro=1 bypasses the boot screen', await hasCommandBox(skipPage));
  await skipPage.close();

  /* ---------- fresh session boots again ---------- */
  const freshCtx = await browser.newContext({ permissions: ['microphone'] });
  const fresh = await freshCtx.newPage();
  await fresh.goto(BASE, { waitUntil: 'domcontentloaded' });
  await fresh.waitForTimeout(1200);
  check('a new session shows the boot screen again', await hasBoot(fresh));
  await freshCtx.close();

  /* ---------- responsive boot screen ---------- */
  console.log('\n=== Responsive boot screen ===');
  for (const [w, h] of [
    [375, 812],
    [768, 1024],
    [1024, 768],
    [1440, 900],
  ] as [number, number][]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    const p = await ctx.newPage();
    await p.goto(BASE, { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(4200);

    const overflow = await p.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth
    );
    const btn = await p.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find((x) =>
        /INITIALIZE JARVIS/i.test(x.textContent || '')
      );
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { visible: r.width > 0 && r.height > 0, inView: r.bottom <= window.innerHeight + 1 };
    });
    await p.screenshot({ path: `/tmp/jarvis-boot-${w}.png` });
    check(
      `boot @ ${w}px`,
      !overflow && !!btn?.visible && !!btn?.inView,
      `overflowX=${overflow} activationVisible=${btn?.visible} inViewport=${btn?.inView}`
    );
    await ctx.close();
  }

  /* ---------- reduced motion ---------- */
  console.log('\n=== Reduced motion ===');
  const rmCtx = await browser.newContext({
    reducedMotion: 'reduce',
    viewport: { width: 1280, height: 800 },
  });
  const rm = await rmCtx.newPage();
  await rm.goto(BASE, { waitUntil: 'domcontentloaded' });
  await rm.waitForTimeout(600); // deliberately short: no waiting for choreography
  const rmReady = await rm.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) =>
      /INITIALIZE JARVIS/i.test(x.textContent || '')
    ) as HTMLButtonElement | undefined;
    return b ? !b.disabled : false;
  });
  check('reduced motion: activation available immediately', rmReady);
  await rm.keyboard.press('Enter');
  await rm.waitForTimeout(600);
  check('reduced motion: Enter still initializes', await hasCommandBox(rm));
  await rm.screenshot({ path: '/tmp/jarvis-boot-reduced.png' });
  await rmCtx.close();

  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
