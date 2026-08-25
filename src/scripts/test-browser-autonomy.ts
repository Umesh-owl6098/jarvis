/**
 * Deterministic browser-autonomy tests against real public sites.
 *
 * NO LLM is involved. These prove the *architecture* — registry addressing,
 * generic search, new-tab handling, dynamic waiting, blocker detection,
 * observation size — not the planner's judgment. That distinction is
 * deliberate: passing here does not mean the agent will choose correctly.
 *
 * Safety: navigation, search and reading only. Nothing is purchased, submitted
 * to an account, or authenticated.
 */

import { BrowserController } from '@/core/browser/controller';
import { NavigationSkill } from '@/skills/navigation';
import { SearchSkill, pickSearchElement } from '@/skills/search';
import { InteractionSkill } from '@/skills/interaction';
import { ObservationBuilder } from '@/core/observation';

type Status = 'PASS' | 'FAIL' | 'BLOCKED';
const results: { test: string; status: Status; note: string }[] = [];

function record(test: string, status: Status, note = '') {
  results.push({ test, status, note });
  const icon = status === 'PASS' ? '✅' : status === 'BLOCKED' ? '🚧' : '❌';
  console.log(`${icon} ${test}${note ? ` — ${note}` : ''}`);
}

const sizeOf = (s: string) => ({
  chars: s.length,
  bytes: Buffer.byteLength(s, 'utf8'),
});

async function main() {
  const browser = new BrowserController();
  await browser.initialize();
  const nav = new NavigationSkill(browser);
  const search = new SearchSkill(browser);
  const interact = new InteractionSkill(browser);

  const obsSizes: { site: string; chars: number; bytes: number; elements: number; total: number }[] = [];

  /** Navigate + report observation size. */
  async function visit(site: string, task: string) {
    const out = await nav.execute({ url: site });
    if (!out.success) throw new Error(`navigate ${site}: ${out.error}`);
    await browser.waitForSettled(6000);
    const obs = await ObservationBuilder.buildFromBrowser(browser, task);
    const payload = ObservationBuilder.formatForLLM(obs);
    const { chars, bytes } = sizeOf(payload);
    obsSizes.push({
      site,
      chars,
      bytes,
      elements: obs.interactiveElements.length,
      total: obs.elementsTotalFound,
    });
    return obs;
  }

  /* ---------- 1. search: wikipedia ---------- */
  try {
    await visit('wikipedia.org', 'Search Wikipedia for OpenAI');
    const out = await search.execute({ query: 'OpenAI' });
    if (!out.success) {
      record('wikipedia search OpenAI', 'FAIL', String(out.error));
    } else {
      const r = out.result as any;
      const ok = /openai/i.test(r.url) || /openai/i.test(r.title || '');
      record(
        'wikipedia search OpenAI',
        ok ? 'PASS' : 'FAIL',
        `url=${r.url} title="${r.title}" via=${r.usedElementId}`
      );
    }
  } catch (e: any) {
    record('wikipedia search OpenAI', 'FAIL', e.message);
  }

  /* ---------- 2. search: github ---------- */
  try {
    await visit('github.com', 'Search GitHub for React repositories');
    const out = await search.execute({ query: 'React' });
    if (!out.success) {
      record('github search React', 'FAIL', String(out.error));
    } else {
      const r = out.result as any;
      const ok = /search|q=/i.test(r.url) && /react/i.test(decodeURIComponent(r.url));
      record('github search React', ok ? 'PASS' : 'FAIL', `url=${r.url} title="${r.title}"`);
    }
  } catch (e: any) {
    record('github search React', 'FAIL', e.message);
  }

  /* ---------- 3. search: amazon (safe: search only) ---------- */
  try {
    await visit('amazon.com', 'Search Amazon for Sony headphones');
    const blockers = await browser.detectBlockers();
    const captcha = blockers.find((b) => b.kind === 'captcha');
    if (captcha) {
      record('amazon search Sony headphones', 'BLOCKED', `CAPTCHA_DETECTED: ${captcha.detail}`);
    } else {
      const out = await search.execute({ query: 'Sony headphones' });
      if (!out.success) {
        const blocked = /CAPTCHA_DETECTED/.test(String(out.error));
        record(
          'amazon search Sony headphones',
          blocked ? 'BLOCKED' : 'FAIL',
          String(out.error)
        );
      } else {
        const r = out.result as any;
        const ok = /sony/i.test(decodeURIComponent(r.url)) || /sony/i.test(r.title || '');
        record(
          'amazon search Sony headphones',
          ok ? 'PASS' : 'FAIL',
          `url=${String(r.url).slice(0, 90)} captchaAfter=${r.captchaAfterSearch ?? 'none'}`
        );
      }
    }
  } catch (e: any) {
    record('amazon search Sony headphones', 'FAIL', e.message);
  }

  /* ---------- 4. new-tab handling ---------- */
  try {
    const page = browser.getPage()!;
    await page.setContent(`
      <a id="t" href="https://example.com/" target="_blank" rel="noopener">open new tab</a>
    `);
    const snap = await browser.snapshotElements();
    const link = snap.elements.find((e) => e.role === 'link');
    if (!link) throw new Error('registry did not capture the target=_blank link');

    const before = browser.listPages().length;
    const out = await interact.execute({ action: 'click', elementId: link.id });
    const after = browser.listPages().length;
    const r = out.result as any;
    const ok = out.success && r?.newTab === true && after > before && /example\.com/.test(r.url);
    record(
      'new-tab handling',
      ok ? 'PASS' : 'FAIL',
      `tabs ${before}->${after} active=${r?.url} newTab=${r?.newTab}`
    );
    await browser.closeActivePage();
    await browser.switchToPage(0);
  } catch (e: any) {
    record('new-tab handling', 'FAIL', e.message);
  }

  /* ---------- 5. dynamic content ---------- */
  try {
    const page = browser.getPage()!;
    await page.setContent(`
      <button id="go">Load results</button><div id="out"></div>
      <script>
        document.getElementById('go').onclick = () => {
          setTimeout(() => {
            document.getElementById('out').innerHTML =
              '<ul><li class="r">alpha</li><li class="r">beta</li><li class="r">gamma</li></ul>';
          }, 1200);
        };
      </script>
    `);
    const snap = await browser.snapshotElements();
    const btn = snap.elements.find((e) => e.role === 'button');
    if (!btn) throw new Error('button not registered');

    const t0 = Date.now();
    await interact.execute({ action: 'click', elementId: btn.id });
    await browser.waitForVisible('li.r', 8000);
    const count = await page.locator('li.r').count();
    const ms = Date.now() - t0;
    record(
      'dynamic content',
      count === 3 ? 'PASS' : 'FAIL',
      `${count} results after ${ms}ms (bounded wait, no fixed sleep)`
    );
  } catch (e: any) {
    record('dynamic content', 'FAIL', e.message);
  }

  /* ---------- 6. popup/modal detection ---------- */
  try {
    const page = browser.getPage()!;
    await page.setContent(`
      <div role="dialog" aria-label="We value your privacy"
           style="position:fixed;inset:0;width:100%;height:100%;background:#fff">
        <button id="acc">Accept all cookies</button>
      </div>
      <button id="under">Search</button>
    `);
    const blockers = await browser.detectBlockers();
    const modal = blockers.find((b) => b.kind === 'modal');
    record(
      'popup detection',
      modal ? 'PASS' : 'FAIL',
      modal ? `modal reported: "${modal.detail}"` : 'blocking dialog not detected'
    );
  } catch (e: any) {
    record('popup detection', 'FAIL', e.message);
  }

  /* ---------- 7. CAPTCHA detection (must detect, never solve) ---------- */
  try {
    const page = browser.getPage()!;
    await page.setContent(`
      <h1>Enter the characters you see below</h1>
      <p>Sorry, we just need to make sure you're not a robot.</p>
    `);
    const blockers = await browser.detectBlockers();
    const captcha = blockers.find((b) => b.kind === 'captcha');
    const out = await search.execute({ query: 'anything' });
    const refused = !out.success && /CAPTCHA_DETECTED/.test(String(out.error));
    record(
      'captcha detection + refusal',
      captcha && refused ? 'PASS' : 'FAIL',
      refused ? 'search refused with CAPTCHA_DETECTED (no bypass attempted)' : `out=${JSON.stringify(out).slice(0, 120)}`
    );
  } catch (e: any) {
    record('captcha detection + refusal', 'FAIL', e.message);
  }

  /* ---------- 8. unsafe action refusal ---------- */
  try {
    const page = browser.getPage()!;
    await page.setContent(`<button id="b">Add to Cart</button><button id="c">Read more</button>`);
    const snap = await browser.snapshotElements();
    const cart = snap.elements.find((e) => /add to cart/i.test(e.name ?? ''));
    if (!cart) throw new Error('cart button not registered');
    const out = await interact.execute({ action: 'click', elementId: cart.id });
    const refused = !out.success && /UNSAFE_ACTION_REFUSED/.test(String(out.error));
    record('unsafe action refusal', refused ? 'PASS' : 'FAIL', String(out.error ?? 'click was allowed'));
  } catch (e: any) {
    record('unsafe action refusal', 'FAIL', e.message);
  }

  /* ---------- 9. stale element id handling ---------- */
  try {
    const page = browser.getPage()!;
    await page.setContent(`<button>One</button>`);
    await browser.snapshotElements();
    await page.setContent(`<button>Two</button>`); // ids wiped by re-render
    const out = await interact.execute({ action: 'click', elementId: 'e1' });
    const clean = !out.success && /ELEMENT_NOT_FOUND/.test(String(out.error));
    record('stale element id', clean ? 'PASS' : 'FAIL', String(out.error ?? 'no error raised'));
  } catch (e: any) {
    record('stale element id', 'FAIL', e.message);
  }

  await browser.close();

  /* ---------- observation sizes ---------- */
  console.log('\n=== Observation payload sizes (what the planner receives) ===');
  for (const o of obsSizes) {
    console.log(
      `  ${o.site.padEnd(16)} ${String(o.chars).padStart(6)} chars  ` +
        `${String(o.bytes).padStart(6)} bytes  ` +
        `${String(o.elements).padStart(3)} elements sent (of ${o.total} actionable)`
    );
  }

  console.log('\n=== SUMMARY ===');
  for (const r of results) console.log(`  ${r.status.padEnd(8)} ${r.test}`);
  const failed = results.filter((r) => r.status === 'FAIL').length;
  const blocked = results.filter((r) => r.status === 'BLOCKED').length;
  console.log(`\n${results.length - failed - blocked} passed, ${failed} failed, ${blocked} blocked`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
