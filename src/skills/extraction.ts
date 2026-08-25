import { z } from 'zod';
import { BaseSkill, SkillMetadata, SkillOutput } from './base';
import { BrowserController } from '@/core/browser/controller';

const ExtractTextInputSchema = z.object({
  selector: z.string().optional(),
});

/**
 * ExtractionSkill: Deterministic data extraction from the page.
 * The LLM should use this to get information without reasoning through selectors.
 */
export class ExtractionSkill extends BaseSkill {
  metadata: SkillMetadata = {
    id: 'extraction',
    name: 'Extract',
    description:
      'Extract data from the page. {"type":"title"} and {"type":"url"} take no other input. ' +
      '{"type":"visible_text"} returns ALL visible text on the page with no selector needed — use this for "what does this page say / let you do" style requests. ' +
      '{"type":"text","selector":"..."} returns text from ONE specific element and REQUIRES "selector" — omitting it always fails. ' +
      '{"type":"screenshot"} takes no other input.',
    version: '1.0.0',
  };

  inputSchema = z.discriminatedUnion('type', [
    z.object({ type: z.literal('title') }),
    z.object({ type: z.literal('url') }),
    z.object({ type: z.literal('visible_text') }),
    z.object({ type: z.literal('text'), ...ExtractTextInputSchema.shape }),
    z.object({ type: z.literal('screenshot') }),
  ]);

  constructor(private browser: BrowserController) {
    super();
  }

  async execute(input: unknown): Promise<SkillOutput> {
    this.validateInput(input);
    const data = input as any;

    try {
      if (data.type === 'title') {
        const title = await this.browser.getTitle();
        return { success: true, result: { title } };
      }

      if (data.type === 'url') {
        const url = await this.browser.getURL();
        return { success: true, result: { url } };
      }

      if (data.type === 'visible_text') {
        const text = await this.browser.getVisibleText();
        return { success: true, result: { text, length: text.length } };
      }

      if (data.type === 'text') {
        const extractInput = ExtractTextInputSchema.parse(data);
        if (!extractInput.selector) {
          return { success: false, error: 'selector required for text extraction' };
        }
        const text = await this.browser.getText(extractInput.selector);
        return { success: true, result: { text } };
      }

      if (data.type === 'screenshot') {
        const path = await this.browser.screenshot();
        return { success: true, result: { screenshotPath: path } };
      }

      return { success: false, error: 'Unknown extraction type' };
    } catch (error: any) {
      return {
        success: false,
        error: error.message,
      };
    }
  }
}
