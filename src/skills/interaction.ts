import { z } from 'zod';
import { BaseSkill, SkillMetadata, SkillOutput } from './base';
import { BrowserController } from '@/core/browser/controller';
import { BrowserError, describeError } from '@/core/browser/errors';

/**
 * InteractionSkill: deterministic page interaction addressed by ElementRegistry
 * id (`e1`, `e2`, …) rather than CSS selectors.
 *
 * The planner sees ids in the observation and returns one; Playwright resolves
 * it via the `data-jarvis-id` stamp. The model never has to invent a selector,
 * which is where real-site automation usually breaks.
 *
 * Safety: this skill refuses actions whose accessible name indicates a
 * consequential operation (purchase, checkout, payment, account changes).
 */

const ElementId = z.string().regex(/^e\d+$/, 'elementId must look like "e12"');

const ClickSchema = z.object({ action: z.literal('click'), elementId: ElementId });
const TypeSchema = z.object({
  action: z.literal('type'),
  elementId: ElementId,
  text: z.string(),
  /** Press Enter after typing — the usual way to submit a search box. */
  submit: z.boolean().optional().default(false),
});
const PressSchema = z.object({
  action: z.literal('press'),
  elementId: ElementId,
  key: z.string().min(1),
});
const SelectSchema = z.object({
  action: z.literal('select'),
  elementId: ElementId,
  value: z.string().min(1),
});
const ScrollSchema = z.object({
  action: z.literal('scroll'),
  direction: z.enum(['up', 'down']),
  amount: z.number().positive().default(3),
});
const BackSchema = z.object({ action: z.literal('back') });
const ForwardSchema = z.object({ action: z.literal('forward') });
const SwitchTabSchema = z.object({
  action: z.literal('switch_tab'),
  index: z.number().int().nonnegative().optional(),
});

/**
 * Consequential-action guard. Matched against the element's accessible name.
 * This is a backstop, not the only control — the planner prompt also forbids
 * these — so a mis-planned click cannot complete a purchase.
 */
const FORBIDDEN_NAME = new RegExp(
  [
    'buy now',
    'place your order',
    'place order',
    'proceed to checkout',
    'checkout',
    'add to cart',
    'add to basket',
    'complete purchase',
    'confirm payment',
    'pay now',
    'subscribe and pay',
    'delete account',
    'close account',
    'change password',
    'update password',
    'send message',
    'send email',
    'post comment',
    'sign in',
    'log in',
    'login',
    'create account',
    'sign up',
  ].join('|'),
  'i'
);

export class InteractionSkill extends BaseSkill {
  metadata: SkillMetadata = {
    id: 'interaction',
    name: 'Interact',
    description:
      'Interact with the page using element ids from the observation. Actions: ' +
      'click {elementId} | type {elementId, text, submit?} | press {elementId, key} | ' +
      'select {elementId, value} | scroll {direction, amount} | back | forward | switch_tab {index?}',
    version: '2.0.0',
  };

  inputSchema = z.discriminatedUnion('action', [
    ClickSchema,
    TypeSchema,
    PressSchema,
    SelectSchema,
    ScrollSchema,
    BackSchema,
    ForwardSchema,
    SwitchTabSchema,
  ]);

  constructor(private browser: BrowserController) {
    super();
  }

  /**
   * Accessible name of a registry element, for the safety check.
   * Reads the existing stamp — re-snapshotting here would mint new ids and
   * make stale ids appear valid.
   */
  private async assertSafe(elementId: string): Promise<void> {
    const name = (await this.browser.describeElement(elementId)) ?? '';
    if (name && FORBIDDEN_NAME.test(name)) {
      throw new BrowserError(
        'UNSAFE_ACTION_REFUSED',
        `Refused to activate "${name}" — purchases, checkout, account and messaging actions are not permitted`
      );
    }
  }

  async execute(input: unknown): Promise<SkillOutput> {
    this.validateInput(input);
    const data = this.inputSchema.parse(input);

    try {
      switch (data.action) {
        case 'click': {
          await this.assertSafe(data.elementId);
          const r = await this.browser.clickElement(data.elementId);
          await this.browser.waitForSettled(6000);
          if (!r.effective) {
            // The click completed without exception but nothing measurable
            // changed (URL, tab count, visible text, control count) — a
            // decorative wrapper or dead handler, not a real interaction.
            return {
              success: false,
              error: `[ACTION_NO_EFFECT] Click on ${data.elementId} completed but nothing on the page changed`,
            };
          }
          return { success: true, result: { action: 'click', elementId: data.elementId, ...r } };
        }

        case 'type': {
          await this.assertSafe(data.elementId);
          await this.browser.fillElement(data.elementId, data.text);
          let navigated = false;
          let url: string | undefined;
          if (data.submit) {
            const r = await this.browser.pressKeyOn(data.elementId, 'Enter');
            navigated = r.navigated;
            url = r.url;
            await this.browser.waitForSettled(8000);
          }
          return {
            success: true,
            result: { action: 'type', elementId: data.elementId, submitted: data.submit, navigated, url },
          };
        }

        case 'press': {
          await this.assertSafe(data.elementId);
          const r = await this.browser.pressKeyOn(data.elementId, data.key);
          await this.browser.waitForSettled(6000);
          return { success: true, result: { action: 'press', key: data.key, ...r } };
        }

        case 'select': {
          const values = await this.browser.selectOptionOn(data.elementId, data.value);
          return { success: true, result: { action: 'select', elementId: data.elementId, values } };
        }

        case 'scroll': {
          await this.browser.scroll(data.direction, data.amount);
          await this.browser.waitForSettled(3000);
          return { success: true, result: { action: 'scroll', direction: data.direction } };
        }

        case 'back': {
          const url = await this.browser.back();
          return { success: true, result: { action: 'back', url } };
        }

        case 'forward': {
          const url = await this.browser.forward();
          return { success: true, result: { action: 'forward', url } };
        }

        case 'switch_tab': {
          const url =
            data.index === undefined
              ? await this.browser.switchToLatestPage()
              : await this.browser.switchToPage(data.index);
          if (!url) {
            throw new BrowserError('NEW_TAB_FAILED', 'No other tab was available to switch to');
          }
          return { success: true, result: { action: 'switch_tab', url } };
        }
      }
    } catch (error) {
      const { code, error: message } = describeError(error);
      return { success: false, error: `[${code}] ${message}` };
    }
  }
}
