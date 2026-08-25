/**
 * Voice → agent end-to-end.
 *
 * Only the vendor speech engine is replaced: a fake `SpeechRecognition` is
 * installed before page load and driven from the test. Everything downstream —
 * BrowserSpeechRecognition, useVoiceInput, normalisation, the submit path, SSE,
 * the executor, bootstrap and Playwright — is the real production code.
 *
 * This proves the pipeline and command integrity. It does NOT prove that real
 * speech is transcribed correctly.
 */

import { chromium, type Page } from 'playwright';

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

/** Fake engine: records every instance so the test can emit results. */
const FAKE_ENGINE = `
(() => {
  class FakeRecognition {
    constructor() {
      this.lang=''; this.continuous=false; this.interimResults=false; this.maxAlternatives=1;
      this.onresult=null; this.onerror=null; this.onend=null;
      this.onstart=null; this.onspeechstart=null; this.onspeechend=null;
      this.running=false;
      window.__fakeRecognitions = window.__fakeRecognitions || [];
      window.__fakeRecognitions.push(this);
    }
    start(){ this.running=true; window.__fakeActive=this; this.onstart && this.onstart(); }
    stop(){ if(!this.running) return; this.running=false; this.onend && this.onend(); }
    abort(){ this.running=false; }
  }
  window.SpeechRecognition = FakeRecognition;
  window.webkitSpeechRecognition = FakeRecognition;

  // Deliver a final transcript through the live adapter.
  window.__speak = (transcript) => {
    const rec = window.__fakeActive;
    if (!rec || !rec.running) return 'no active recognition';
    rec.onspeechstart && rec.onspeechstart();
    const mk = (t, isFinal) => ({
      resultIndex: 0,
      results: Object.assign([Object.assign([{transcript:t, confidence:0.95}], {isFinal})], {length:1}),
    });
    rec.onresult && rec.onresult(mk(transcript, false));
    rec.onresult && rec.onresult(mk(transcript, true));
    rec.onspeechend && rec.onspeechend();
    return 'spoken';
  };
})();
`;

const voiceLabel = (p: Page) =>
  p.evaluate(() => {
    const m = document.body.innerText.match(/VOICE\n([^\n]+)/);
    return m ? m[1].trim() : null;
  });

/**
 * Chrome recycles recognition sessions, and the hook restarts them ~250ms
 * later. The HUD stays on "Listening" across that gap, so a test must retry
 * rather than assume a session is live at any instant.
 */
async function speak(p: Page, transcript: string, timeoutMs = 15000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = 'never attempted';
  while (Date.now() < deadline) {
    last = await p.evaluate((t) => (window as any).__speak(t), transcript);
    if (last === 'spoken') return last;
    await p.waitForTimeout(200);
  }
  return last;
}

const readField = (p: Page, re: RegExp) =>
  p.evaluate((src) => {
    const m = document.body.innerText.match(new RegExp(src, 'm'));
    return m ? m[1].trim() : null;
  }, re.source);

async function main() {
  const browser = await chromium.launch({
    channel: 'chrome',
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  });
  const ctx = await browser.newContext({
    permissions: ['microphone'],
    viewport: { width: 1440, height: 900 },
  });
  await ctx.addInitScript(FAKE_ENGINE);
  const page = await ctx.newPage();

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4200);
  await page.keyboard.press('Enter');
  // Wait for a live session rather than guessing a delay — speaking into a
  // not-yet-started recogniser is a test bug, not a product bug.
  const becameLive = await page
    .waitForFunction(() => /VOICE\nLISTENING/.test(document.body.innerText), { timeout: 30000 })
    .then(() => true)
    .catch(() => false);
  check('listening after initialization', becameLive, String(await voiceLabel(page)));

  /* ---------- spoken command ---------- */
  const SPOKEN = 'Jarvis, open wikipedia.org';
  const spoke = await speak(page, SPOKEN);
  check('transcript delivered to the live adapter', spoke === 'spoken', String(spoke));

  await page.waitForTimeout(1200);

  const submitted = await page.evaluate(
    () => (document.getElementById('jarvis-command') as HTMLTextAreaElement)?.value ?? ''
  );
  const directive = await readField(page, /DIRECTIVE\n([^\n]+)/);
  check(
    'wake word stripped, command submitted verbatim',
    directive === 'open wikipedia.org',
    `directive="${directive}" box="${submitted}"`
  );
  check('no example.com leakage', !/example\.com/i.test(JSON.stringify({ directive, submitted })));

  const pausedLabel = await voiceLabel(page);
  check(
    'recognition suspended while the task runs',
    pausedLabel === 'PAUSED' || pausedLabel === 'COMMAND RECEIVED',
    String(pausedLabel)
  );

  /* ---------- wait for the task to resolve ---------- */
  // Poll the PHASE readout itself; matching arbitrary body text picks up
  // trace lines like "Action completed" and resolves mid-task.
  const terminal = await page
    .waitForFunction(
      () => {
        const m = document.body.innerText.match(/PHASE\n([^\n]+)/);
        const phase = m ? m[1].trim() : '';
        return ['COMPLETED', 'FAILED', 'STOPPED'].includes(phase) ? phase : false;
      },
      { timeout: 180000 }
    )
    .then((h) => h.jsonValue())
    .catch(() => null);
  check('task reached a terminal phase', terminal !== null, `phase=${terminal}`);
  await page.waitForTimeout(800);

  const url = await readField(page, /\nURL\n([^\n]+)/);
  const title = await readField(page, /DOCUMENT TITLE\n([^\n]+)/);
  const phase = await readField(page, /PHASE\n([^\n]+)/);
  const result =
    (await readField(page, /RETURNED PAYLOAD\n+([^\n]+)/)) ??
    (await readField(page, /FAULT REPORT\n+([^\n]+)/));

  check(
    'browser navigated to the spoken destination',
    !!url && /wikipedia\.org/i.test(url),
    `url=${url} title=${title}`
  );
  console.log(`   phase=${phase}`);
  console.log(`   result=${String(result).slice(0, 140)}`);

  /* ---------- microphone returns on its own ---------- */
  await page.waitForTimeout(3000);
  const after = await voiceLabel(page);
  check('microphone returns to LISTENING after the task', after === 'LISTENING', String(after));

  /* ---------- bare domain by voice ---------- */
  await page
    .waitForFunction(() => /VOICE\nLISTENING/.test(document.body.innerText), { timeout: 20000 })
    .catch(() => {});
  const spoke2 = await speak(page, 'Jarvis, amazon.com');
  // Wait for the directive to actually change rather than sampling a fixed delay.
  await page
    .waitForFunction(() => /DIRECTIVE\namazon\.com/.test(document.body.innerText), { timeout: 15000 })
    .catch(() => {});
  const directive2 = await readField(page, /DIRECTIVE\n([^\n]+)/);
  check(
    'bare spoken domain normalises correctly',
    directive2 === 'amazon.com',
    `spoke=${spoke2} directive="${directive2}"`
  );

  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
