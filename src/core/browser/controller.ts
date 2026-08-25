import { Browser, BrowserContext, Locator, Page, chromium } from 'playwright';
import { ElementRegistry, JARVIS_GEN_ATTR } from './registry';
import {
  BrowserError,
  CAPTCHA_SIGNATURES,
  CAPTCHA_TEXT_CUES,
  describeError,
  type BrowserErrorCode,
  type PageBlocker,
} from './errors';

export class BrowserController {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  /** Every page in the context, oldest first. Kept for tab switching. */
  private pages: Page[] = [];
  /** Incremented on every registry snapshot; stamped onto each element via data-jarvis-gen. */
  private registryVersion = 0;
  /** Bounded budget for scroll-and-look exploration when a target id resolves to nothing. */
  private scrollExplorationBudget = 3;

  async initialize() {
    // Idempotent: a live session is not discarded and replaced silently.
    // Every production caller constructs one BrowserController per task and
    // calls this exactly once, so this only ever matters for a caller that
    // deliberately pre-initializes/pre-navigates before handing the
    // controller to something that also calls initialize().
    if (this.isAlive()) {
      console.log('Browser already initialized; reusing existing session');
      return;
    }
    try {
      this.browser = await chromium.launch({ headless: false });
      // A single persistent context keeps cookies for the whole session — the
      // hook future authenticated work will need. No credentials are stored.
      this.context = await this.browser.newContext();
      this.page = await this.context.newPage();
      this.pages = [this.page];

      // Real sites open links in new tabs; adopt them so the agent follows.
      this.context.on('page', (p) => {
        if (!this.pages.includes(p)) this.pages.push(p);
        p.on('close', () => {
          this.pages = this.pages.filter((x) => x !== p);
          if (this.page === p) this.page = this.pages[this.pages.length - 1] ?? null;
        });
      });

      console.log('Browser initialized');
    } catch (error) {
      console.error('Failed to initialize browser:', error);
      throw error;
    }
  }

  /**
   * Checkpoint 16: still throws on connection/DNS/timeout failure — same
   * contract every existing caller (including test-phase1e-recovery.ts,
   * which explicitly asserts a throw for an unreachable domain) already
   * relies on. What's new: the RESOLVED case now also returns the
   * main-document HTTP status Playwright observed (after following any
   * redirects — goto() returns the final response), since "the call didn't
   * throw" was never the same thing as "the destination is usable" — a
   * 404/500 doesn't throw, the server just answered with an error status.
   */
  async goto(url: string): Promise<{ finalUrl: string; httpStatus?: number }> {
    if (!this.page) throw new Error('Browser not initialized');
    try {
      // 'networkidle' never settles on real sites that hold connections open
      // (analytics, long-poll), and aborts when a redirect supersedes the
      // navigation. Commit on DOM, then give the load event a bounded chance.
      const response = await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await this.page.waitForLoadState('load', { timeout: 8000 }).catch(() => {});
      return { finalUrl: this.page.url(), httpStatus: response?.status() };
    } catch (error) {
      throw new Error(`Failed to navigate to ${url}: ${error}`);
    }
  }

  async screenshot(filename?: string) {
    if (!this.page) throw new Error('Browser not initialized');
    try {
      const path = filename || `/tmp/screenshot-${Date.now()}.png`;
      await this.page.screenshot({ path });
      return path;
    } catch (error) {
      throw new Error(`Failed to take screenshot: ${error}`);
    }
  }

  async click(selector: string) {
    if (!this.page) throw new Error('Browser not initialized');
    try {
      await this.page.click(selector);
      return `Clicked ${selector}`;
    } catch (error) {
      throw new Error(`Failed to click ${selector}: ${error}`);
    }
  }

  async type(selector: string, text: string) {
    if (!this.page) throw new Error('Browser not initialized');
    try {
      await this.page.fill(selector, text);
      return `Typed "${text}" into ${selector}`;
    } catch (error) {
      throw new Error(`Failed to type into ${selector}: ${error}`);
    }
  }

  async getText(selector: string) {
    if (!this.page) throw new Error('Browser not initialized');
    try {
      const text = await this.page.textContent(selector);
      return text || '';
    } catch (error) {
      throw new Error(`Failed to get text from ${selector}: ${error}`);
    }
  }

  async scroll(direction: 'up' | 'down', amount: number = 3) {
    if (!this.page) throw new Error('Browser not initialized');
    try {
      const pixels = amount * 100;
      if (direction === 'down') {
        await this.page.evaluate(`window.scrollBy(0, ${pixels})`);
      } else {
        await this.page.evaluate(`window.scrollBy(0, -${pixels})`);
      }
      return `Scrolled ${direction} by ${pixels}px`;
    } catch (error) {
      throw new Error(`Failed to scroll: ${error}`);
    }
  }

  async waitForElement(selector: string, timeout: number = 5000) {
    if (!this.page) throw new Error('Browser not initialized');
    try {
      await this.page.waitForSelector(selector, { timeout });
      return `Element ${selector} found`;
    } catch (error) {
      throw new Error(`Element ${selector} not found within ${timeout}ms`);
    }
  }

  async getPageContent() {
    if (!this.page) throw new Error('Browser not initialized');
    try {
      const content = await this.page.content();
      return content;
    } catch (error) {
      throw new Error(`Failed to get page content: ${error}`);
    }
  }

  async getTitle(): Promise<string> {
    this.assertAlive();
    try {
      return await this.page!.title();
    } catch (error) {
      // A closure discovered mid-call must surface as a category, not as
      // "Failed to get page title: <playwright stack>".
      const live = this.livenessError();
      if (live) throw live;
      throw new BrowserError('PAGE_CLOSED', `Could not read page title: ${String(error).split('\n')[0]}`);
    }
  }

  async getURL(): Promise<string> {
    this.assertAlive();
    return this.page!.url();
  }

  async getVisibleText(): Promise<string> {
    this.assertAlive();
    try {
      // body can be null during navigation/interstitials — must not throw.
      return await this.page!.evaluate(() => document.body?.innerText ?? '');
    } catch (error) {
      const live = this.livenessError();
      if (live) throw live;
      throw new BrowserError('PAGE_CLOSED', `Could not read page text: ${String(error).split('\n')[0]}`);
    }
  }

  getPage(): Page | null {
    return this.page;
  }

  /* ---------------- tabs ---------------- */

  /** Pages currently open, in creation order. */
  listPages(): { index: number; url: string; active: boolean }[] {
    return this.pages.map((p, index) => ({
      index,
      url: p.url(),
      active: p === this.page,
    }));
  }

  /**
   * Adopt the most recently opened page as active. Returns null when no new
   * page appeared, so callers can report NEW_TAB_FAILED rather than hang.
   */
  async switchToLatestPage(timeoutMs = 3000): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const candidate = this.pages[this.pages.length - 1];
      if (candidate && candidate !== this.page) {
        this.page = candidate;
        await candidate.bringToFront().catch(() => {});
        await candidate
          .waitForLoadState('domcontentloaded', { timeout: 10000 })
          .catch(() => {});
        return candidate.url();
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    return null;
  }

  async switchToPage(index: number): Promise<string> {
    const target = this.pages[index];
    if (!target) throw new BrowserError('NEW_TAB_FAILED', `No page at index ${index}`);
    this.page = target;
    await target.bringToFront().catch(() => {});
    return target.url();
  }

  async closeActivePage(): Promise<void> {
    if (!this.page || this.pages.length <= 1) return;
    await this.page.close().catch(() => {});
  }

  /* ---------------- history ---------------- */

  async back(): Promise<string> {
    if (!this.page) throw new Error('Browser not initialized');
    await this.page.goBack({ waitUntil: 'domcontentloaded', timeout: 20000 });
    return this.page.url();
  }

  async forward(): Promise<string> {
    if (!this.page) throw new Error('Browser not initialized');
    await this.page.goForward({ waitUntil: 'domcontentloaded', timeout: 20000 });
    return this.page.url();
  }

  /* ---------------- element-id addressing ---------------- */

  private locate(elementId: string) {
    if (!this.page) throw new Error('Browser not initialized');
    return this.page.locator(ElementRegistry.selectorFor(elementId)).first();
  }

  /**
   * Re-resolve an id fresh every time it's about to be acted on, rather than
   * trusting a Locator handed out earlier in the step. `count() === 0` covers
   * the common case (a new snapshot cleared the stamp entirely); the caller
   * additionally tracks its own `registryVersion` snapshot to catch the
   * narrower case of a re-snapshot happening *during* one action attempt.
   */
  private async requireElement(elementId: string) {
    this.assertAlive();
    const loc = this.locate(elementId);
    if ((await loc.count()) === 0) {
      throw new BrowserError(
        'ELEMENT_NOT_FOUND',
        `Element ${elementId} is no longer on the page; observe again for fresh ids`
      );
    }
    return loc;
  }

  /** Cheap page-state fingerprint for "did anything actually change" checks. Not a full observation. */
  private async quickSample(): Promise<{ len: number; nodes: number }> {
    if (!this.page) return { len: 0, nodes: 0 };
    return this.page
      .evaluate(() => ({
        len: document.body?.innerText?.length ?? 0,
        nodes: document.body?.querySelectorAll('a,button,input,[role]').length ?? 0,
      }))
      .catch(() => ({ len: 0, nodes: 0 }));
  }

  /**
   * What's actually sitting at the target's center point right now — a one-
   * line diagnostic ("div.sticky-header"), not a claim about *why* Playwright
   * failed. Best-effort: swallow every failure, never throw from here.
   */
  private async describeOccluder(loc: Locator): Promise<string | null> {
    try {
      const box = await loc.boundingBox();
      if (!box || !this.page) return null;
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;
      return await this.page.evaluate(
        ({ cx, cy }) => {
          const el = document.elementFromPoint(cx, cy) as HTMLElement | null;
          if (!el) return null;
          const cls =
            el.className && typeof el.className === 'string'
              ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.')
              : '';
          return `${el.tagName.toLowerCase()}${cls}`.slice(0, 60);
        },
        { cx, cy }
      );
    } catch {
      return null;
    }
  }

  /**
   * A content item's linked id may address inner text, an icon, or a wrapper
   * div rather than the actual clickable node. Look one hop up (nearest
   * interactive ancestor) then one hop down (nearest interactive descendant)
   * within the SAME element — never a sibling or unrelated container, so this
   * can only ever resolve to something that represents the original target.
   */
  private async semanticFallbackTarget(
    loc: Locator
  ): Promise<{ loc: Locator; kind: 'ancestor' | 'descendant' } | null> {
    const ancestor = loc
      .locator('xpath=ancestor::*[self::a[@href] or self::button or @role="link" or @role="button"]')
      .first();
    if ((await ancestor.count().catch(() => 0)) > 0) return { loc: ancestor, kind: 'ancestor' };

    const descendant = loc.locator('a[href], button, [role="link"], [role="button"]').first();
    if ((await descendant.count().catch(() => 0)) > 0) return { loc: descendant, kind: 'descendant' };

    return null;
  }

  /**
   * Click by registry id. Follows a fixed, bounded ladder rather than jumping
   * to force-click:
   *   1. normal click
   *   2. re-resolve + scroll into view
   *   3. bounded wait — retry ONCE, but only if the page was observed to
   *      still be changing (retrying against a truly static failure wastes a
   *      full timeout for no new information)
   *   4. nearest semantically-equivalent clickable ancestor/descendant
   * `force: true` is never used — see errors.ts codes; a blocked click stays
   * classified (occluded/moving/detached/...) rather than pushed through.
   */
  async clickElement(
    elementId: string
  ): Promise<{
    url: string;
    navigated: boolean;
    newTab: boolean;
    effective: boolean;
    usedFallback: 'none' | 'retry' | 'ancestor' | 'descendant';
  }> {
    const versionAtStart = this.registryVersion;
    let loc: Locator;
    try {
      loc = await this.requireElement(elementId);
    } catch (err) {
      // The target may simply not be rendered yet (content one viewport
      // below the fold). Bounded, cheap insurance — NOT a fix for true
      // virtualization, which needs a fresh id from a fresh observation
      // either way, but common enough to be worth one scroll.
      if (err instanceof BrowserError && err.code === 'ELEMENT_NOT_FOUND' && this.scrollExplorationBudget > 0) {
        this.scrollExplorationBudget--;
        await this.scroll('down', 8).catch(() => {});
        await this.waitForSettled(2000);
      }
      throw err;
    }

    const before = this.page!.url();
    const pagesBefore = this.pages.length;
    const preSample = await this.quickSample();
    let usedFallback: 'none' | 'retry' | 'ancestor' | 'descendant' = 'none';

    const attempt = async (target: Locator) => {
      await target.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
      await target.click({ timeout: 10000 });
    };

    try {
      await attempt(loc);
    } catch (firstError) {
      // A re-snapshot happened mid-attempt (only our own retry ladder does
      // this, via scroll-exploration above) — the id may now mean something
      // else. Do not blindly retry it; make the caller re-observe.
      if (this.registryVersion !== versionAtStart) {
        throw new BrowserError(
          'STALE_OBSERVATION',
          `Element ${elementId} was resolved from a page state that has since changed; observe again`
        );
      }

      loc = await this.requireElement(elementId);

      // Only worth a blind retry if the page was actually still moving —
      // sample twice across a bounded window rather than assume.
      const midSample = await this.quickSample();
      await new Promise((r) => setTimeout(r, 600));
      const laterSample = await this.quickSample();
      const stillChanging = midSample.len !== laterSample.len || midSample.nodes !== laterSample.nodes;

      let recovered = false;
      if (stillChanging) {
        try {
          await attempt(loc);
          recovered = true;
          usedFallback = 'retry';
        } catch {
          // fall through to semantic fallback
        }
      }

      if (!recovered) {
        const fallback = await this.semanticFallbackTarget(loc);
        if (fallback) {
          try {
            await attempt(fallback.loc);
            loc = fallback.loc;
            recovered = true;
            usedFallback = fallback.kind;
          } catch {
            // fall through to the classified failure below
          }
        }
      }

      if (!recovered) {
        const occluder = await this.describeOccluder(loc);
        const { code, error: msg } = describeError(firstError);
        const finalCode: BrowserErrorCode =
          code === 'UNKNOWN' || code === 'DYNAMIC_CONTENT_TIMEOUT' ? 'ELEMENT_NOT_INTERACTABLE' : code;
        throw new BrowserError(finalCode, occluder ? `${msg} (currently covered by ~${occluder})` : msg);
      }
    }

    // Give a same-tab navigation or a popup a bounded moment to appear.
    await this.page!.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 250));

    let newTab = false;
    if (this.pages.length > pagesBefore) {
      const url = await this.switchToLatestPage(2000);
      if (url) newTab = true;
    }

    const after = this.page!.url();
    const navigated = after !== before || newTab;

    // Success without exception is not the same as success — a click that
    // lands but changes nothing (a decorative wrapper, a no-op handler) is
    // indistinguishable from a real interaction unless something measurable
    // actually moved.
    let effective = navigated;
    if (!effective) {
      const postSample = await this.quickSample();
      effective = Math.abs(postSample.len - preSample.len) > 20 || postSample.nodes !== preSample.nodes;
    }

    return { url: after, navigated, newTab, effective, usedFallback };
  }

  /**
   * Enter text into an element.
   *
   * `fill()` only works on real form controls. Some sites expose search as a
   * div with role=searchbox, or as a palette trigger that mounts its input on
   * activation — GitHub does both. In that case focus the affordance and type,
   * which is what a person would do.
   *
   * Returns true when the keyboard fallback was used, because the caller then
   * has to submit via the page keyboard rather than the original element.
   */
  async fillElement(elementId: string, text: string): Promise<boolean> {
    const loc = await this.requireElement(elementId);
    await loc.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
    try {
      await loc.fill(text, { timeout: 8000 });
      return false;
    } catch (error) {
      if (!/not an <input>|not editable|role allowing/i.test(String(error))) throw error;
      await loc.click({ timeout: 8000 });
      // Let a palette mount its real input before typing.
      await this.page!.waitForTimeout(400);
      await this.page!.keyboard.type(text, { delay: 15 });
      return true;
    }
  }

  /** Submit from wherever focus currently is. */
  async pressKeyGlobal(key: string): Promise<{ url: string; navigated: boolean }> {
    this.assertAlive();
    const before = this.page!.url();
    await this.page!.keyboard.press(key);
    await this.page!.waitForLoadState('domcontentloaded', { timeout: 12000 }).catch(() => {});
    return { url: this.page!.url(), navigated: this.page!.url() !== before };
  }

  async pressKeyOn(elementId: string, key: string): Promise<{ url: string; navigated: boolean }> {
    const loc = await this.requireElement(elementId);
    await loc.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
    const before = this.page!.url();
    await loc.press(key, { timeout: 10000 });
    await this.page!.waitForLoadState('domcontentloaded', { timeout: 12000 }).catch(() => {});
    return { url: this.page!.url(), navigated: this.page!.url() !== before };
  }

  async selectOptionOn(elementId: string, value: string): Promise<string[]> {
    const loc = await this.requireElement(elementId);
    await loc.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
    try {
      return await loc.selectOption({ label: value }, { timeout: 8000 });
    } catch {
      return await loc.selectOption(value, { timeout: 8000 });
    }
  }

  /* ---------------- bounded dynamic waiting ---------------- */

  /**
   * Wait for the page to *settle* without relying on `networkidle`: either the
   * URL changes, or the visible text stops changing across consecutive samples.
   * Always bounded.
   */
  async waitForSettled(timeoutMs = 8000): Promise<void> {
    if (!this.page) return;
    const deadline = Date.now() + timeoutMs;
    let previous = -1;
    let stable = 0;

    while (Date.now() < deadline) {
      const sample = await this.page
        .evaluate(() => ({
          ready: document.readyState,
          len: document.body?.innerText?.length ?? 0,
          nodes: document.body?.querySelectorAll('a,button,input').length ?? 0,
        }))
        .catch(() => null);

      // An empty or still-loading document is NOT settled: two zero-length
      // samples in a row would otherwise look perfectly stable.
      const usable =
        sample !== null && sample.ready !== 'loading' && (sample.len > 0 || sample.nodes > 0);

      if (usable) {
        if (sample.len === previous) {
          if (++stable >= 2) return;
        } else {
          stable = 0;
          previous = sample.len;
        }
      } else {
        stable = 0;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  /** Wait until a locator is visible. Throws DYNAMIC_CONTENT_TIMEOUT on failure. */
  async waitForVisible(selector: string, timeoutMs = 10000): Promise<void> {
    if (!this.page) throw new Error('Browser not initialized');
    try {
      await this.page.locator(selector).first().waitFor({ state: 'visible', timeout: timeoutMs });
    } catch {
      throw new BrowserError(
        'DYNAMIC_CONTENT_TIMEOUT',
        `"${selector}" did not become visible within ${timeoutMs}ms`
      );
    }
  }

  /* ---------------- blockers ---------------- */

  /**
   * Detect CAPTCHA / bot walls and blocking modals.
   *
   * Detection only. JARVIS never attempts to solve or evade a challenge.
   */
  async detectBlockers(): Promise<PageBlocker[]> {
    if (!this.page) return [];
    const blockers: PageBlocker[] = [];

    for (const sig of CAPTCHA_SIGNATURES) {
      const found = await this.page
        .locator(sig)
        .first()
        .isVisible({ timeout: 500 })
        .catch(() => false);
      if (found) {
        blockers.push({ kind: 'captcha', detail: `challenge element matched ${sig}` });
        break;
      }
    }

    if (blockers.length === 0) {
      const head = (await this.getVisibleText().catch(() => '')).slice(0, 1200).toLowerCase();
      const cue = CAPTCHA_TEXT_CUES.find((c) => head.includes(c));
      if (cue) blockers.push({ kind: 'captcha', detail: `page text contains "${cue}"` });
    }

    const modal = await this.page
      .evaluate(() => {
        const nodes = Array.from(
          document.querySelectorAll('[role="dialog"], [aria-modal="true"], dialog[open]')
        );
        for (const n of nodes) {
          const r = n.getBoundingClientRect();
          const st = window.getComputedStyle(n);
          if (st.display === 'none' || st.visibility === 'hidden') continue;
          // Only count dialogs large enough to actually obstruct interaction.
          if (r.width * r.height < 40000) continue;
          const label =
            n.getAttribute('aria-label') ||
            (n.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80);
          return label || 'dialog';
        }
        return null;
      })
      .catch(() => null);

    if (modal) blockers.push({ kind: 'modal', detail: modal });

    // Cookie/consent/promo bars rarely use role=dialog, but share a shape:
    // fixed/sticky, anchored to a viewport edge, a handful of buttons/links
    // (not a full nav with dozens). Structural only — no text/keyword
    // matching, so this stays generic across sites rather than chasing
    // specific consent-vendor markup.
    if (!modal) {
      const banner = await this.page
        .evaluate(() => {
          const vh = window.innerHeight;
          const vw = window.innerWidth;
          const nodes = Array.from(document.body?.querySelectorAll('*') ?? []).slice(0, 2000);
          for (const n of nodes) {
            const st = window.getComputedStyle(n);
            if (st.position !== 'fixed' && st.position !== 'sticky') continue;
            if (st.display === 'none' || st.visibility === 'hidden' || parseFloat(st.opacity || '1') === 0) continue;
            const r = n.getBoundingClientRect();
            if (r.width < vw * 0.5 || r.height < 24) continue;
            const nearTop = r.top < 20;
            const nearBottom = vh - r.bottom < 20;
            if (!nearTop && !nearBottom) continue;
            if (nearTop && r.height > 100) continue; // likely the main nav header, not a bar
            const controls = n.querySelectorAll('button, a[href]').length;
            if (controls === 0 || controls > 6) continue; // 0 = decorative; >6 = probably real nav
            const label = (n.getAttribute('aria-label') || (n.textContent || '')).replace(/\s+/g, ' ').trim().slice(0, 80);
            return label || `sticky bar (${nearBottom ? 'bottom' : 'top'}-anchored)`;
          }
          return null;
        })
        .catch(() => null);
      if (banner) blockers.push({ kind: 'modal', detail: `sticky banner: ${banner}` });
    }

    return blockers;
  }

  /**
   * Accessible name of an already-stamped element.
   *
   * Deliberately does NOT re-snapshot: re-stamping would mint fresh ids and
   * make a stale id look valid again.
   */
  async describeElement(elementId: string): Promise<string | null> {
    if (!this.page) return null;
    const loc = this.page.locator(ElementRegistry.selectorFor(elementId)).first();
    if ((await loc.count()) === 0) return null;
    const name =
      (await loc.getAttribute('aria-label').catch(() => null)) ||
      (await loc.textContent().catch(() => null)) ||
      (await loc.getAttribute('value').catch(() => null)) ||
      (await loc.getAttribute('title').catch(() => null));
    return (name || '').replace(/\s+/g, ' ').trim();
  }

  /* ---------------- liveness ---------------- */

  /**
   * Is the session usable right now?
   *
   * Cheap and synchronous where possible: Playwright exposes `isClosed()` on
   * both page and browser, so we can answer without touching the target.
   */
  isAlive(): boolean {
    if (!this.page || this.page.isClosed()) return false;
    if (this.browser && !this.browser.isConnected()) return false;
    return true;
  }

  /**
   * Why the session is unusable, or null when it is fine. Used to turn a raw
   * "Target page, context or browser has been closed" into a category.
   */
  livenessError(): BrowserError | null {
    if (this.browser && !this.browser.isConnected()) {
      return new BrowserError('BROWSER_CLOSED', 'The browser process is no longer connected');
    }
    if (!this.page) {
      return new BrowserError('PAGE_CLOSED', 'No active page in this browser session');
    }
    if (this.page.isClosed()) {
      return new BrowserError('PAGE_CLOSED', 'The active page has been closed');
    }
    return null;
  }

  /** Throw a structured error if the session is dead. */
  assertAlive(): void {
    const err = this.livenessError();
    if (err) throw err;
  }

  /**
   * Try to make the session usable again without restarting the browser:
   * if the context survived but the page died, adopt/open a page.
   * Returns true when a usable page is available afterwards.
   */
  async recoverPage(): Promise<boolean> {
    if (this.isAlive()) return true;
    if (this.browser && !this.browser.isConnected()) return false;
    if (!this.context) return false;

    const live = this.pages.filter((p) => !p.isClosed());
    if (live.length > 0) {
      this.page = live[live.length - 1];
      this.pages = live;
      return true;
    }
    try {
      const page = await this.context.newPage();
      this.pages = [page];
      this.page = page;
      return true;
    } catch {
      return false;
    }
  }

  /** Registry snapshot of the active page. Bumps the generation counter. */
  async snapshotElements(max?: number) {
    if (!this.page) throw new Error('Browser not initialized');
    this.registryVersion++;
    return ElementRegistry.snapshot(this.page, { ...(max ? { max } : {}), version: this.registryVersion });
  }

  /** Current registry generation, for callers that need to reason about staleness. */
  getRegistryVersion(): number {
    return this.registryVersion;
  }

  async close() {
    try {
      for (const p of this.pages) await p.close().catch(() => {});
      this.pages = [];
      if (this.page) await this.page.close().catch(() => {});
      if (this.context) await this.context.close();
      if (this.browser) await this.browser.close();
      console.log('Browser closed');
    } catch (error) {
      console.error('Error closing browser:', error);
    }
  }
}

export const browser = new BrowserController();
