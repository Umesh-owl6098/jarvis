import { z } from 'zod';
import { OmniRouteClient } from '@/core/router/client';
import { SkillRegistry } from '@/skills/registry';
import { ContextManager } from '@/core/context';
import { PageObservation } from '@/core/observation';
import { formatProgressForLLM, type TaskProgress } from './goal-state';

/**
 * Planner: Decides what action to take based on task and observation.
 * Uses OmniRoute to avoid expensive calls when deterministic logic would work.
 *
 * Token optimization strategy:
 * 1. Never send full HTML
 * 2. Send compact PageObservation
 * 3. List available skills (LLM picks one)
 * 4. For simple decisions, use cheap model
 * 5. For complex reasoning, use capable model
 */

/** What went wrong on the previous attempt, handed to the next plan. */
export interface PlannerFailureContext {
  action: string;
  code: string;
  error: string;
  url: string;
  urlChanged: boolean;
  domChanged: boolean;
  attempts: number;
  targetTitle?: string;
  targetPrice?: string;
  alternativeHref?: string;
  alternateActionElementId?: string;
}

export const PlannerActionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('use_skill'),
    skillId: z.string().describe('Which skill to invoke'),
    input: z.unknown().describe('Skill input'),
    reasoning: z.string(),
  }),
  z.object({
    action: z.literal('finish'),
    result: z.string().describe('Summary of what was accomplished'),
  }),
  z.object({
    action: z.literal('fail'),
    reason: z.string().describe('Why the task failed'),
  }),
]);

export type PlannerAction = z.infer<typeof PlannerActionSchema>;


/**
 * Extract candidate JSON objects from a model response.
 *
 * Models frequently wrap the object in prose or markdown fences. A greedy
 * first-brace-to-last-brace match breaks as soon as any other brace appears,
 * so scan for brace-balanced candidates instead (string- and escape-aware) and
 * return them longest-first for the caller to validate.
 */
export function extractJsonCandidates(raw: string): string[] {
  const text = raw
    .replace(/^\s*```(?:json)?/gim, '')
    .replace(/```\s*$/gim, '')
    .trim();

  const candidates: string[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = i; j < text.length; j++) {
      const ch = text[j];
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) { candidates.push(text.slice(i, j + 1)); break; }
      }
    }
  }
  return candidates.sort((a, b) => b.length - a.length);
}

export class Planner {
  private plannerAttempt: number = 0;

  constructor(
    private omniroute: OmniRouteClient,
    private skills: SkillRegistry,
    private context: ContextManager,
  ) {}

  /**
   * Decide what to do based on current state.
   * Returns structured action that can be validated and executed.
   */
  async plan(
    observation: PageObservation,
    failure?: PlannerFailureContext | null,
    progress?: TaskProgress,
    signal?: AbortSignal
  ): Promise<PlannerAction> {
    this.plannerAttempt = 0;
    return this.planInternal(observation, failure, progress, signal);
  }

  private async planInternal(
    observation: PageObservation,
    failure?: PlannerFailureContext | null,
    progress?: TaskProgress,
    signal?: AbortSignal
  ): Promise<PlannerAction> {
    this.plannerAttempt++;

    // Build minimal prompt
    const skillsList = this.skills.getSkillsPrompt();
    const contextForLLM = this.context.getContextForLLM(progress);
    const contextObj = JSON.parse(contextForLLM);

    // Build system prompt with strong guidance
    const systemPrompt = `You are an autonomous web agent. Your goal is to accomplish tasks by browsing and interacting with web pages.

Available skills:
${skillsList}

CRITICAL RULES:
0. Keep "reasoning" under 12 words. Long reasoning can push the JSON past the
   output limit and truncate it mid-object, which fails the whole step.
1. Respond ONLY with valid JSON matching the schema below
2. Do NOT hallucinate skills - use only the skills listed above
3. Do NOT repeat the same action twice in a row - check recentActions
4. If the page is loaded and the task needs extracted content (e.g. a title or the page's text), extract AT MOST ONCE. The moment an extraction skill call succeeds, your very next action MUST be "finish" using that result. Do not extract again "to be sure," do not re-observe first — repeating a just-succeeded extraction is always wrong
5. Only repeat an action if the previous attempt clearly failed
6. Keep actions simple and deterministic
7. If the task names a website or domain, navigate to THAT destination. Never substitute a different site. A bare domain such as "example.org" means "https://example.org"
8. Match the work to what was asked, finish as soon as it's satisfied: "open X" -> navigate, finish. "open X and tell me Y" -> navigate, extract Y, finish. "search X for Q" -> navigate, search, finish describing results. Do not invent extraction or search that wasn't requested
9. "result" must describe what happened for THIS task, using the actual url/title from currentPage
10. Interact using element ids from currentPage.elements (e.g. "e3"). Never invent selectors or use ids not listed — observe again if unsure
11. If currentPage.blockers contains a captcha, immediately "fail" with that fact. Never solve or bypass a human-verification challenge
12. If a modal blocks the task, dismiss it only when clearly inconsequential (e.g. a cookie notice). Never accept marketing, notifications, or anything account-related
13. SAFETY — never: purchases, checkout, add-to-cart, payments, logins/sign-ups, sending messages/email, deleting data, or changing account/security settings. If required, "fail" and explain
14. currentPage.contentItems is pre-compared, ranked data (title/price mapped to an action id). Reason from it directly — compare, pick the match — before clicking around to "look for" something already listed. "Cheapest/least costly item" = identify from contentItems, then optionally open/view via its "action" id. Never add to cart/buy/checkout even if asked to "select" — crosses rule 13; "finish" reporting the item and price instead
15. Once any action lands you on the page the task asked for, it's DONE — "finish" immediately citing what you found. Do NOT navigate away to re-verify or re-click — that undoes progress, whether you got there by clicking or navigating directly
16. open/view/follow/select-to-look-at are READ-ONLY; submit/buy/add/delete/send/confirm are STATE-CHANGING. A contentItem's "href" substitutes only for a READ-ONLY click, never a state-changing one. If a click on a contentItem's "action" id fails and that item's "actionRole" is "link" with "href", and the task only asked to open/view/select, use the navigation skill with that href instead of retrying. Never retry an identical failed click a third time — "finish" reporting what you found or "fail" with the reason instead
17. A TASK PROGRESS block, if present, is ground truth — a committed "selectedTarget" stays committed, a milestone marked "done" stays done. Don't re-derive it from prose

Response format:
{
  "action": "use_skill" | "finish" | "fail",
  "skillId": "...",  // Only if action is "use_skill"
  "input": {...},    // Only if action is "use_skill"
  "reasoning": "...",
  "result": "...",   // Only if action is "finish"
  "reason": "..."    // Only if action is "fail"
}

Output a single JSON object and NOTHING else. No explanation, no reasoning, no
markdown fences, no text before or after the object.`;

    // Telling the planner *what already failed* is the difference between
    // re-planning and re-trying the identical action until the loop guard fires.
    const targetBlock = failure?.targetTitle
      ? `
  target           : ${failure.targetTitle}${failure.targetPrice ? ` (${failure.targetPrice})` : ''}`
      : '';
    const alternativeLines: string[] = [];
    if (failure?.alternativeHref) alternativeLines.push(`href available: ${failure.alternativeHref}`);
    if (failure?.alternateActionElementId) alternativeLines.push(`alternate action id available: ${failure.alternateActionElementId}`);
    const alternativeBlock = alternativeLines.length
      ? `
  alternative      : ${alternativeLines.join('; ')}`
      : '';

    const failureBlock = failure
      ? `
THE PREVIOUS ACTION FAILED.
  action attempted : ${failure.action}
  failure code     : ${failure.code}
  detail           : ${failure.error}
  url now          : ${failure.url}
  url changed      : ${failure.urlChanged}
  page changed     : ${failure.domChanged}
  consecutive tries: ${failure.attempts}${targetBlock}${alternativeBlock}

DO NOT REPEAT THE IDENTICAL ACTION UNLESS NEW PAGE STATE JUSTIFIES IT.
Choose a different target or a different approach. If an "href available" line is
present, that is a plain navigation to the same item, not a click — appropriate
for an "open/view/select" style request (see rule 16), never for add-to-cart or
checkout. If the page does not expose what the task needs, "finish" with an
honest summary of what was achieved, or "fail" with the reason — do not keep
retrying.
`
      : '';

    // Structured evidence, not another rule — the planner reasons about
    // whatever this shows (an already-committed target, milestones already
    // done) rather than re-deriving task state from prose every step.
    const progressText = progress ? formatProgressForLLM(progress) : null;
    const progressBlock = progressText
      ? `
TASK PROGRESS
  ${progressText}
`
      : '';

    const userPrompt = `Current state:
${contextForLLM}
${progressBlock}
${failureBlock}

${this.plannerAttempt === 1 ? 'What should I do next?' : 'Your previous response was invalid JSON. Please respond ONLY with a single valid JSON object.'}

Respond ONLY with valid JSON. No other text.`;

    try {
      console.log(`[Planner] Attempt ${this.plannerAttempt}: Asking LLM`);
      if (this.plannerAttempt === 1) {
        console.log(`[integrity] planner.task=${JSON.stringify(contextObj.task)}`);
        console.log(`[Planner] Context sent: task="${contextObj.task}", url="${contextObj.currentPage?.url || 'none'}", recent=${contextObj.recentActions?.length || 0} actions`);
      }
      // Checkpoint 12 §1/§14: per-step size breakdown, dev-console only.
      // Byte counts use UTF-8 length, not .length (char count), since that's
      // what the provider actually bills for on non-ASCII content.
      const byteLen = (s: string) => Buffer.byteLength(s, 'utf8');
      console.log(
        `[Metrics] step attempt=${this.plannerAttempt} ` +
          `obsBytes=${byteLen(contextForLLM)} ` +
          `elements=${contextObj.currentPage?.elements?.length ?? 0} ` +
          `contentItems=${contextObj.currentPage?.contentItems?.length ?? 0} ` +
          `progressBytes=${byteLen(progressBlock)} ` +
          `failureBytes=${byteLen(failureBlock)} ` +
          `historyActions=${contextObj.recentActions?.length ?? 0} ` +
          `systemPromptBytes=${byteLen(systemPrompt)} ` +
          `userPromptBytes=${byteLen(userPrompt)}`
      );

      // Use cheap model for simple decisions
      // Dedicated planner routing: preferred structured-output model with a
      // short fallback chain, low temperature, and a token budget large enough
      // that a verbose `reasoning` field cannot truncate the JSON.
      const response = await this.omniroute.generateForPlanning({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }, signal);

      // Track token usage
      this.context.recordTokenUsage(response.inputTokens, response.outputTokens);
      this.context.recordPlannerCall(this.plannerAttempt > 1);

      // Parse and validate response
      const content = response.content.trim();

      console.log(`[Planner] Response: "${content.substring(0, 100)}${content.length > 100 ? '...' : ''}"`);

      // Try the whole response first, then any brace-balanced object inside it.
      // Validate each candidate against the schema so prose containing braces
      // cannot masquerade as an action.
      let action: unknown;
      let matched = false;
      const candidates = [content, ...extractJsonCandidates(content)];
      for (const candidate of candidates) {
        try {
          const parsed = JSON.parse(candidate);
          PlannerActionSchema.parse(parsed);
          action = parsed;
          matched = true;
          break;
        } catch {
          // try the next candidate
        }
      }

      if (!matched) {
        if (this.plannerAttempt < 2) {
          console.log('[Planner] No schema-valid JSON action found, retrying once...');
          return this.planInternal(observation, failure, progress, signal);
        }
        throw new Error(
          `No schema-valid JSON action in response: ${content.substring(0, 160)}`
        );
      }

      const validated = PlannerActionSchema.parse(action);
      console.log(`[Planner] Action: ${validated.action}${validated.action === 'use_skill' ? ` (${(validated as any).skillId})` : ''}`);
      return validated;
    } catch (error: any) {
      // Post-CP23 fix — a cancellation must reach executor.ts's own
      // `error.name === 'AbortError'` check UNCHANGED. Wrapping it into a
      // generic Error (as every other failure below still is) would lose
      // that name and make executor.ts report a real cancellation as a
      // generic "failed" task instead of the clean "stopped" result it's
      // supposed to produce.
      if (signal?.aborted || error?.name === 'AbortError') throw error;
      throw new Error(`Planner failed: ${error.message}`);
    }
  }

  /**
   * Get prompt tokens used by this planner.
   */
  getTokensUsed(): number {
    return this.context.getTokenUsage();
  }
}
