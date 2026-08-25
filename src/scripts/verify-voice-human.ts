/**
 * Real-microphone verification harness.
 *
 * Opens a REAL Chrome window against the running JARVIS, using the system's
 * actual microphone and the browser's own SpeechRecognition engine. Nothing is
 * stubbed: no fake device, no injected transcript, no synthetic events.
 *
 * You speak; this records what the engine heard, what was submitted, and what
 * the agent did, then prints the verification table.
 *
 * It cannot speak for you — that is the whole point of this checkpoint.
 *
 * Usage: npm run verify:voice-human
 */

import { chromium, type Page } from 'playwright';
import { createInterface } from 'node:readline/promises';

const BASE = 'http://localhost:3000';

interface VoiceLogEntry {
  at: string;
  adapter: string;
  raw: string;
  normalized: string;
  hadWakeWord: boolean;
  confidence: number | null;
}

const PROMPTS = [
  { id: 'TEST 1', say: 'Jarvis, open wikipedia.org', expectHost: 'wikipedia.org' },
  { id: 'TEST 2', say: 'Jarvis, open amazon.com', expectHost: 'amazon.com' },
  { id: 'TEST 3', say: 'Jarvis, open wikipedia.org and search for OpenAI', expectHost: 'wikipedia.org' },
  { id: 'NO-PREFIX', say: 'Open github.com', expectHost: 'github.com' },
];

const field = (p: Page, src: string) =>
  p.evaluate((s) => {
    const m = document.body.innerText.match(new RegExp(s, 'm'));
    return m ? m[1].trim() : null;
  }, src);

const voiceState = (p: Page) => field(p, 'VOICE\\n([^\\n]+)');
const voiceLog = (p: Page) =>
  p.evaluate(() => ((window as any).__jarvisVoiceLog ?? []) as VoiceLogEntry[]);

async function main() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  console.log('\n=== REAL MICROPHONE VERIFICATION ===');
  console.log('A real Chrome window will open. Your actual microphone and the');
  console.log("browser's own speech engine are used — nothing is stubbed.\n");

  const browser = await chromium.launch({
    channel: 'chrome',
    headless: false,
    // Deliberately NO --use-fake-device-for-media-stream: we want the real mic.
  });
  const ctx = await browser.newContext({
    permissions: ['microphone'],
    viewport: { width: 1440, height: 900 },
  });
  const page = await ctx.newPage();

  page.on('console', (m) => {
    const t = m.text();
    if (t.startsWith('[voice]')) console.log('   ' + t);
  });

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4500);

  const bootVisible = await page.evaluate(
    () => !!document.querySelector('[aria-label="JARVIS initialization"]')
  );
  const hudBefore = await page.evaluate(() => !!document.getElementById('jarvis-command'));
  console.log(`intro visible before Enter : ${bootVisible}`);
  console.log(`HUD mounted before Enter   : ${hudBefore}  (should be false)`);
  console.log(`mic active before Enter    : ${(await voiceState(page)) ?? 'n/a (no HUD yet)'}\n`);

  await rl.question('Focus the JARVIS window, press ENTER there, approve the mic prompt, then press Enter here… ');

  const becameLive = await page
    .waitForFunction(() => /VOICE\nLISTENING/.test(document.body.innerText), { timeout: 60000 })
    .then(() => true)
    .catch(() => false);

  console.log(`\nauto-start after Enter     : ${becameLive ? 'LISTENING (no click)' : 'DID NOT REACH LISTENING'}`);
  const adapterSeen = (await voiceLog(page))[0]?.adapter;
  console.log(`voice state now            : ${await voiceState(page)}`);
  if (!becameLive) {
    console.log('\nMicrophone never became active. Check the browser mic permission and retry.');
    await rl.close();
    await browser.close();
    process.exit(1);
  }

  const rows: any[] = [];

  for (const prompt of PROMPTS) {
    console.log(`\n${'─'.repeat(70)}\n${prompt.id} — say out loud:  "${prompt.say}"`);
    await rl.question('Press Enter here once you have spoken it… ');

    const before = (await voiceLog(page)).length;
    // Give the engine a moment to finalise if the user pressed Enter early.
    const got = await page
      .waitForFunction(
        (n) => (((window as any).__jarvisVoiceLog ?? []) as unknown[]).length > n,
        before,
        { timeout: 45000 }
      )
      .then(() => true)
      .catch(() => false);

    if (!got) {
      console.log('   no transcript captured — the engine heard nothing usable.');
      rows.push({ ...prompt, raw: null, normalized: null, phase: null });
      continue;
    }

    const log = await voiceLog(page);
    const entry = log[log.length - 1];
    const phase = await page
      .waitForFunction(
        () => {
          const m = document.body.innerText.match(/PHASE\n([^\n]+)/);
          const v = m ? m[1].trim() : '';
          return ['COMPLETED', 'FAILED', 'STOPPED'].includes(v) ? v : false;
        },
        { timeout: 240000 }
      )
      .then((h) => h.jsonValue() as Promise<string>)
      .catch(() => null);

    await page.waitForTimeout(1000);
    const micAfter = await page
      .waitForFunction(() => /VOICE\nLISTENING/.test(document.body.innerText), { timeout: 30000 })
      .then(() => 'LISTENING')
      .catch(async () => (await voiceState(page)) ?? 'unknown');

    const row = {
      ...prompt,
      adapter: entry.adapter,
      raw: entry.raw,
      normalized: entry.normalized,
      confidence: entry.confidence,
      directive: await field(page, 'DIRECTIVE\\n([^\\n]+)'),
      phase,
      url: await field(page, '\\nURL\\n([^\\n]+)'),
      title: await field(page, 'DOCUMENT TITLE\\n([^\\n]+)'),
      tokens: await field(page, 'TOKENS\\n([^\\n]+)'),
      result:
        (await field(page, 'RETURNED PAYLOAD\\n+([^\\n]+)')) ??
        (await field(page, 'FAULT REPORT\\n+([^\\n]+)')),
      micAfter,
    };
    rows.push(row);

    console.log(`   adapter    : ${row.adapter}`);
    console.log(`   RAW        : ${JSON.stringify(row.raw)}`);
    console.log(`   NORMALIZED : ${JSON.stringify(row.normalized)}`);
    console.log(`   directive  : ${JSON.stringify(row.directive)}`);
    console.log(`   phase      : ${row.phase}   final URL: ${row.url}`);
    console.log(`   title      : ${row.title}`);
    console.log(`   mic after  : ${row.micAfter}`);

    const reset = page.locator('button', { hasText: 'Reset' }).first();
    if (await reset.count()) await reset.click().catch(() => {});
  }

  /* ---------- mute / unmute with a live utterance ---------- */
  console.log(`\n${'─'.repeat(70)}\nMUTE TEST`);
  await page.locator('button', { hasText: 'Mic On' }).first().click().catch(() => {});
  await page.waitForTimeout(600);
  const mutedState = await voiceState(page);
  console.log(`   after clicking mic: ${mutedState}`);
  const beforeMuteLog = (await voiceLog(page)).length;
  await rl.question('   While MUTED, say "Jarvis, open example.com", then press Enter here… ');
  const afterMuteLog = (await voiceLog(page)).length;
  const mutedSubmitted = afterMuteLog > beforeMuteLog;
  console.log(`   transcripts captured while muted: ${afterMuteLog - beforeMuteLog} (must be 0)`);

  await page.locator('button', { hasText: 'Mic Off' }).first().click().catch(() => {});
  const resumed = await page
    .waitForFunction(() => /VOICE\nLISTENING/.test(document.body.innerText), { timeout: 30000 })
    .then(() => true)
    .catch(() => false);
  console.log(`   after unmute: ${resumed ? 'LISTENING' : await voiceState(page)}`);

  /* ---------- report ---------- */
  console.log(`\n${'='.repeat(70)}\nREAL MICROPHONE RESULTS`);
  console.log(`adapter in use        : ${adapterSeen ?? rows.find((r) => r.adapter)?.adapter ?? 'unknown'}`);
  console.log(`auto-start after Enter: ${becameLive ? 'PASS' : 'FAIL'}`);
  for (const r of rows) {
    const heardRight = r.normalized && r.url && r.url.includes(r.expectHost);
    console.log(`\n${r.id}  ${heardRight && r.phase === 'COMPLETED' ? 'PASS' : 'CHECK'}`);
    console.log(`  spoken     : ${r.say}`);
    console.log(`  raw        : ${JSON.stringify(r.raw)}`);
    console.log(`  normalized : ${JSON.stringify(r.normalized)}`);
    console.log(`  submitted  : ${JSON.stringify(r.directive)}`);
    console.log(`  final URL  : ${r.url}`);
    console.log(`  title      : ${r.title}`);
    console.log(`  result     : ${String(r.result).slice(0, 110)}`);
    console.log(`  mic after  : ${r.micAfter}`);
    if (r.raw && r.normalized && !String(r.url ?? '').includes(r.expectHost)) {
      console.log(`  NOTE: transcription differed from what was spoken — reported verbatim, not corrected.`);
    }
  }
  console.log(`\nMUTE/UNMUTE : ${!mutedSubmitted && resumed ? 'PASS' : 'CHECK'} (submitted while muted: ${mutedSubmitted})`);
  console.log('\nLeave the browser open to inspect, then press Enter to close.');
  await rl.question('');
  await rl.close();
  await browser.close();
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
