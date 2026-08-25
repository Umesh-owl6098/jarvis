import { z } from 'zod';
import { BaseSkill, SkillMetadata, SkillOutput } from './base';
import { BrowserController } from '@/core/browser/controller';
import { BrowserError, describeError } from '@/core/browser/errors';
import type { RegisteredElement } from '@/core/browser/registry';

/**
 * SearchSkill: site-agnostic "type a query into this page's search box and
 * submit it".
 *
 * No site-specific selectors. The target is chosen from the ElementRegistry by
 * role and accessible-name signals, so the same code path works on Wikipedia,
 * GitHub, Amazon or anything else that exposes a search field. The planner may
 * also pass an explicit `elementId` when it can see the right one.
 */

const SearchInputSchema = z.object({
  query: z.string().min(1, 'query is required'),
  /** Optional: use this exact registry element instead of auto-detecting. */
  elementId: z
    .string()
    .regex(/^e\d+$/)
    .optional(),
});

type SearchInput = z.infer<typeof SearchInputSchema>;

/** Name/placeholder cues that identify a search field across sites. */
const SEARCH_CUE = /search|find|query|look ?up/i;

/**
 * Field types that must never receive a search query. Typing into a signup
 * email box is both wrong and mildly hostile to the user.
 */
const NEVER_TYPE_INTO = /^(email|password|tel|number|date|file|url)$/i;

export function pickSearchElement(elements: RegisteredElement[]): RegisteredElement | null {
  const typable = elements.filter(
    (e) =>
      (e.role === 'searchbox' || e.role === 'textbox' || e.role === 'textarea' || e.role === 'editable') &&
      !e.disabled &&
      !(e.type && NEVER_TYPE_INTO.test(e.type))
  );
  if (typable.length === 0) return null;

  const score = (e: RegisteredElement): number => {
    let s = 0;
    if (e.role === 'searchbox') s += 100;
    if (e.type === 'search') s += 80;
    const hay = `${e.name ?? ''} ${e.placeholder ?? ''}`;
    if (SEARCH_CUE.test(hay)) s += 60;
    if (e.inViewport) s += 10;
    s -= Number(e.id.slice(1)) * 0.1;
    return s;
  };

  const ranked = [...typable].sort((a, b) => score(b) - score(a));
  const best = ranked[0];

  // Require a real search signal. Proximity/visibility alone is not enough —
  // that is how a query ends up in a newsletter box.
  const hasSignal =
    best.role === 'searchbox' ||
    best.type === 'search' ||
    SEARCH_CUE.test(`${best.name ?? ''} ${best.placeholder ?? ''}`);
  return hasSignal ? best : null;
}

/**
 * Some sites (GitHub among them) expose no search input until a trigger is
 * activated — a button that opens a command palette or an expanding field.
 * Find that trigger generically by accessible name.
 */
export function pickSearchOpener(elements: RegisteredElement[]): RegisteredElement | null {
  const candidates = elements.filter(
    (e) => (e.role === 'button' || e.role === 'link') && !e.disabled && SEARCH_CUE.test(e.name ?? '')
  );
  if (candidates.length === 0) return null;
  // Prefer visible triggers, then the earliest (highest-value) registry id.
  return (
    candidates.sort(
      (a, b) =>
        Number(!!b.inViewport) - Number(!!a.inViewport) || Number(a.id.slice(1)) - Number(b.id.slice(1))
    )[0] ?? null
  );
}

export class SearchSkill extends BaseSkill {
  metadata: SkillMetadata = {
    id: 'search',
    name: 'Search',
    description:
      "Type a query into the current page's search field and submit it. " +
      'Input: {query, elementId?}. Works on any site that exposes a search box.',
    version: '1.0.0',
  };

  inputSchema = SearchInputSchema;

  constructor(private browser: BrowserController) {
    super();
  }

  async execute(input: unknown): Promise<SkillOutput> {
    this.validateInput(input);
    const data = input as SearchInput;

    try {
      const blockers = await this.browser.detectBlockers();
      const captcha = blockers.find((b) => b.kind === 'captcha');
      if (captcha) {
        throw new BrowserError(
          'CAPTCHA_DETECTED',
          `Human verification required before searching (${captcha.detail}). Stopping — challenges are never bypassed.`
        );
      }

      let snap = await this.browser.snapshotElements();
      let targetId = data.elementId;
      let openedVia: string | undefined;

      if (targetId && !snap.elements.some((e) => e.id === targetId)) {
        targetId = undefined; // stale id — fall back to detection
      }

      if (!targetId) {
        let picked = pickSearchElement(snap.elements);

        // No visible search field: try to reveal one via a search trigger.
        if (!picked) {
          const opener = pickSearchOpener(snap.elements);
          if (opener) {
            openedVia = opener.name ?? opener.id;
            await this.browser.clickElement(opener.id);
            await this.browser.waitForSettled(5000);
            snap = await this.browser.snapshotElements();
            picked = pickSearchElement(snap.elements);
          }
        }

        if (!picked) {
          throw new BrowserError(
            'SEARCH_RESULTS_NOT_FOUND',
            `No search field found among ${snap.elements.length} visible elements` +
              (openedVia ? ` (after activating "${openedVia}")` : '')
          );
        }
        targetId = picked.id;
      }

      const before = await this.browser.getURL();

      const usedKeyboard = await this.browser.fillElement(targetId, data.query);
      // If the text went in via the keyboard, focus has moved off the original
      // element, so Enter must be sent globally rather than to that node.
      const pressed = usedKeyboard
        ? await this.browser.pressKeyGlobal('Enter')
        : await this.browser.pressKeyOn(targetId, 'Enter');
      await this.browser.waitForSettled(9000);

      const url = await this.browser.getURL();
      const title = await this.browser.getTitle();

      // A search that changed neither the URL nor the page is a failure worth
      // reporting rather than silently "succeeding".
      const after = await this.browser.snapshotElements();
      const changed = url !== before || pressed.navigated || after.totalFound !== snap.totalFound;

      if (!changed) {
        throw new BrowserError(
          'SEARCH_RESULTS_NOT_FOUND',
          `Submitting "${data.query}" did not change the page`
        );
      }

      const post = await this.browser.detectBlockers();
      const postCaptcha = post.find((b) => b.kind === 'captcha');

      return {
        success: true,
        result: {
          action: 'search',
          query: data.query,
          usedElementId: targetId,
          openedVia,
          url,
          title,
          navigated: url !== before,
          captchaAfterSearch: postCaptcha ? postCaptcha.detail : undefined,
        },
      };
    } catch (error) {
      const { code, error: message } = describeError(error);
      return { success: false, error: `[${code}] ${message}` };
    }
  }
}
