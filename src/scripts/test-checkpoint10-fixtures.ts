/**
 * Checkpoint 10 — local deterministic fixtures for interaction robustness.
 *
 * Drives BrowserController directly (not through the planner) so each
 * scenario is deterministic and fast: A-G from the checkpoint spec.
 */

import { BrowserController } from '@/core/browser/controller';
import { ElementRegistry } from '@/core/browser/registry';
import path from 'path';

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

async function main() {
  const browser = new BrowserController();
  await browser.initialize();
  const fixtureUrl = `file://${path.join(process.cwd(), 'test-fixture-robustness.html')}`;
  const navStart = Date.now();
  await browser.goto(fixtureUrl);
  const page = browser.getPage()!;

  // Captured immediately, before ANY other snapshotElements() call — a later
  // snapshot restamps every id fresh, which would let this id get reused for
  // a *different* element and make the test about id-reuse, not staleness.
  const staleSnap = await browser.snapshotElements();
  const staleEl = staleSnap.elements.find((e) => (e as any).name === 'Stale Link');
  check('C. stale element found before replacement', !!staleEl, staleEl ? staleEl.id : 'not in registry snapshot');

  // ---------- F: lazy-loaded content after scroll ----------
  // Runs before A: A's scrollIntoViewIfNeeded on a far-off element would
  // otherwise scroll past F's own lazy-load threshold as a side effect.
  {
    const beforeCount = await page.locator('#lazy-list .lazy-card').count();
    await page.evaluate(() => window.scrollTo(0, 1200));
    await page.waitForTimeout(300); // let the 'scroll' listener fire
    const scrollY = await page.evaluate(() => window.scrollY);
    await browser.waitForSettled(2000);
    const afterCount = await page.locator('#lazy-list .lazy-card').count();
    check(
      'F. scrolling reveals lazily-inserted cards on re-snapshot',
      afterCount > beforeCount,
      `scrollY=${scrollY} before=${beforeCount} after=${afterCount}`
    );
    await page.evaluate(() => window.scrollTo(0, 0));
  }

  // ---------- C: target replaced after observation ----------
  // No snapshotElements() call has happened since the capture above (F only
  // uses page.locator directly), so this is a clean single-snapshot test:
  // the element was removed from the DOM: ELEMENT_NOT_FOUND, not a collision.
  {
    // Guarantee the fixture's 1.2s replacement has actually fired — F above
    // can settle faster than that on a quiet page, which would otherwise
    // race the fixture's own JS rather than test JARVIS's behavior.
    const elapsed = Date.now() - navStart;
    if (elapsed < 1500) await new Promise((r) => setTimeout(r, 1500 - elapsed));

    if (!staleEl) {
      check('C. stale id correctly rejected after replacement', false, 'no stale element id captured earlier');
    } else {
      try {
        await browser.clickElement(staleEl.id);
        check('C. stale id correctly rejected after replacement', false, 'click unexpectedly succeeded on replaced node');
      } catch (e: any) {
        check(
          'C. stale id correctly rejected after replacement',
          e.code === 'ELEMENT_NOT_FOUND' || e.code === 'STALE_OBSERVATION',
          `code=${e.code} message=${e.message?.slice(0, 150)}`
        );
      }
    }
  }

  // ---------- A: offscreen clickable ----------
  {
    const snap = await browser.snapshotElements();
    const el = snap.elements.find((e) => (e as any).name === 'Offscreen Link');
    if (!el) {
      check('A. offscreen element found', false, 'not in registry snapshot');
    } else {
      try {
        const r = await browser.clickElement(el.id);
        const text = await page.locator('#a-result').textContent();
        check('A. offscreen element scrolled into view and clicked', r.effective && text === 'offscreen link clicked successfully via scroll and click', JSON.stringify(r));
      } catch (e: any) {
        check('A. offscreen element scrolled into view and clicked', false, e.message?.slice(0, 150));
      }
    }
  }

  // ---------- B: overlay-covered ----------
  {
    const snap = await browser.snapshotElements();
    const el = snap.elements.find((e) => (e as any).name === 'Covered Link');
    if (!el) {
      check('B. covered element found', false, 'not in registry snapshot');
    } else {
      try {
        await browser.clickElement(el.id);
        check('B. covered click correctly classified', false, 'click unexpectedly succeeded through overlay');
      } catch (e: any) {
        check(
          'B. covered click correctly classified as ELEMENT_OCCLUDED (or interactable variant)',
          e.code === 'ELEMENT_OCCLUDED' || /occlud/i.test(e.message ?? ''),
          `code=${e.code} message=${e.message?.slice(0, 150)}`
        );
      }
    }
  }

  // ---------- D: wrapper (descendant) / span-in-link (ancestor) ----------
  {
    // Manually stamp ids the registry would never naturally produce, to
    // simulate a linkedElementId that resolved to the wrong hierarchy level.
    const version = browser.getRegistryVersion() || 1;
    await page.evaluate(
      ({ version }) => {
        const wrapper = document.getElementById('wrapper-target')!;
        wrapper.setAttribute('data-jarvis-id', 'e901');
        wrapper.setAttribute('data-jarvis-gen', String(version));
        const span = document.getElementById('inner-span')!;
        span.setAttribute('data-jarvis-id', 'e902');
        span.setAttribute('data-jarvis-gen', String(version));
      },
      { version }
    );

    try {
      const r1 = await browser.clickElement('e901');
      const text1 = await page.locator('#d-descendant-result').textContent();
      check(
        'D. descendant fallback clicks the real link inside a non-interactive wrapper',
        r1.usedFallback === 'descendant' && text1 === 'child link clicked',
        JSON.stringify(r1)
      );
    } catch (e: any) {
      check('D. descendant fallback clicks the real link inside a non-interactive wrapper', false, e.message?.slice(0, 150));
    }

    try {
      const r2 = await browser.clickElement('e902');
      const text2 = await page.locator('#d-ancestor-result').textContent();
      check(
        'D. ancestor fallback clicks the enclosing link for a non-interactive span',
        r2.usedFallback === 'ancestor' && text2 === 'ancestor link clicked',
        JSON.stringify(r2)
      );
    } catch (e: any) {
      check('D. ancestor fallback clicks the enclosing link for a non-interactive span', false, e.message?.slice(0, 150));
    }
  }

  // ---------- E: new tab ----------
  {
    const snap = await browser.snapshotElements();
    const el = snap.elements.find((e) => (e as any).name === 'Open New Tab');
    if (!el) {
      check('E. new-tab link found', false, 'not in registry snapshot');
    } else {
      const pagesBefore = browser.listPages().length;
      const r = await browser.clickElement(el.id);
      const pagesAfter = browser.listPages().length;
      check(
        'E. new tab detected and adopted as active page',
        r.newTab && pagesAfter > pagesBefore && browser.getPage()!.url().includes('example.com'),
        `newTab=${r.newTab} pagesBefore=${pagesBefore} pagesAfter=${pagesAfter} activeUrl=${browser.getPage()!.url()}`
      );
      // Switch back to the fixture tab for subsequent sections.
      await browser.switchToPage(0);
    }
  }

  // ---------- G: click with no effect ----------
  {
    const snap = await browser.snapshotElements();
    const el = snap.elements.find((e) => (e as any).name === 'Does Nothing');
    if (!el) {
      check('G. no-op element found', false, 'not in registry snapshot');
    } else {
      const r = await browser.clickElement(el.id);
      check('G. no-op click correctly flagged as not effective', r.effective === false, JSON.stringify(r));
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close();
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
