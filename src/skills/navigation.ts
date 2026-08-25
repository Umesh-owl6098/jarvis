import { z } from 'zod';
import { BaseSkill, SkillMetadata, SkillOutput } from './base';
import { BrowserController } from '@/core/browser/controller';
import { normalizeUrl } from '@/core/browser/url';
import { buildNavigationEvidence } from '@/core/browser/navigation-evidence';

// Accept bare domains ("amazon.com") as well as absolute URLs; normalizeUrl
// resolves them to https and rejects anything non-navigable.
const NavigateInputSchema = z.object({
  url: z.string().min(1, 'A URL or domain is required'),
  waitForElement: z.string().optional(),
});

type NavigateInput = z.infer<typeof NavigateInputSchema>;

/**
 * NavigationSkill: Deterministic URL navigation.
 * The LLM should use this instead of reasoning through navigation.
 */
export class NavigationSkill extends BaseSkill {
  metadata: SkillMetadata = {
    id: 'navigation',
    name: 'Navigate',
    description: 'Navigate to a URL. Optionally wait for a specific element to load.',
    version: '1.0.0',
  };

  inputSchema = NavigateInputSchema;

  constructor(private browser: BrowserController) {
    super();
  }

  async execute(input: unknown): Promise<SkillOutput> {
    this.validateInput(input);
    const data = input as NavigateInput;

    let target: string;
    try {
      target = normalizeUrl(data.url).url;
    } catch (error: any) {
      return { success: false, error: `Invalid navigation target: ${error.message}` };
    }

    try {
      const { finalUrl, httpStatus } = await this.browser.goto(target);

      if (data.waitForElement) {
        await this.browser.waitForElement(data.waitForElement);
      }

      // Let late-arriving content land before we report url/title. Sites that
      // set <title> from JS (Amazon) otherwise report an empty title and the
      // planner burns a step re-observing.
      await this.browser.waitForSettled(6000);

      const url = await this.browser.getURL();
      const title = await this.browser.getTitle();

      // Checkpoint 16: the navigation ACTION succeeded (Playwright reached
      // a real response, no exception) — that is still distinct from
      // whether the destination is USABLE. httpStatus/errorPageDetected
      // carry that distinction forward as evidence; the goal evaluator
      // (executor.ts), not this skill, decides what a 404 means for the
      // task's completion.
      const evidence = buildNavigationEvidence({
        requestedUrl: target,
        finalUrl: url || finalUrl,
        httpStatus,
        pageTitle: title,
      });

      return { success: true, result: evidence };
    } catch (error: any) {
      // A thrown goto() means no response ever arrived — DNS/connection
      // failure, timeout. Still surfaced as evidence (browserError set,
      // httpStatus absent), not just a bare error string, so callers that
      // read result-shaped evidence can do so uniformly, but the action
      // itself is still reported as FAILED — unlike a 404, nothing at all
      // was reached here.
      const evidence = buildNavigationEvidence({
        requestedUrl: target,
        finalUrl: await this.browser.getURL().catch(() => target),
        pageTitle: '',
        browserError: error.message,
      });
      return { success: false, error: error.message, result: evidence };
    }
  }
}
