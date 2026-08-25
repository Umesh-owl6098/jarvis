/**
 * FailingMockOmniRoute: Test-only deterministic failure implementation.
 *
 * Runs a normal-looking prefix (navigate → observe) so the UI passes through
 * observing/planning/acting, then deterministically fails the planner. Used
 * ONLY when USE_FAILING_MOCK_ROUTER=true, to visually verify the FAILED state.
 *
 * NOT for production. Mirrors SlowMockOmniRoute's shape and abort semantics.
 */

import { GenerateRequest, GenerateResponse } from './client';
import { destinationFromTask, mockRefusal } from './mock-slow';

/** Number of successful planning calls before the deterministic fault. */
const CALLS_BEFORE_FAILURE = 2;

export class FailingMockOmniRoute {
  private callCount = 0;
  private signal?: AbortSignal;
  private destination: string | null = null;

  constructor(signal?: AbortSignal) {
    this.signal = signal;
  }

  async generate(request: GenerateRequest): Promise<GenerateResponse> {
    this.callCount++;

    console.log(`[FAILING-MOCK] Planning call ${this.callCount}, delaying 3 seconds...`);
    await this.delay(3000, this.signal);

    if (this.callCount > CALLS_BEFORE_FAILURE) {
      console.log('[FAILING-MOCK] Emitting deterministic planner fault');
      throw new Error('Planner unavailable: deterministic test fault (FAILING_MOCK)');
    }

    const userMessage = request.messages.find((m) => m.role === 'user')?.content || '';
    const taskMatch = userMessage.match(/"task"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (taskMatch) this.destination = destinationFromTask(taskMatch[1]);
    if (!this.destination) return mockRefusal(userMessage);
    const inputTokens = Math.ceil(userMessage.length / 4);
    const outputTokens = 100;

    return {
      content: this.generateAction(),
      model: 'failing-mock',
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      provider: 'failing-mock',
      cost: 0,
    };
  }


  /**
   * Planner-specific entry point. Mocks have no model chain to walk — they
   * just answer — but they must expose the same surface the Planner calls,
   * or swapping in a mock breaks the agent rather than the model.
   */
  async generateForPlanning(request: GenerateRequest): Promise<GenerateResponse> {
    return this.generate(request);
  }
  async generateWithStrategy(
    request: GenerateRequest,
    _strategy: 'cheap' | 'balanced' | 'capable' = 'balanced'
  ): Promise<GenerateResponse> {
    return this.generate(request);
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }

  /** Same skill ids/shape as the slow mock, so the prefix runs normally. */
  private generateAction(): string {
    if (this.callCount === 1) {
      return JSON.stringify({
        action: 'use_skill',
        skillId: 'navigation',
        input: { url: this.destination },
        reasoning: `Navigate to ${this.destination}`,
      });
    }
    return JSON.stringify({
      action: 'use_skill',
      skillId: 'extraction',
      input: { type: 'title' },
      reasoning: 'Extract page title',
    });
  }

  private delay(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error('Aborted'));
        return;
      }
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(new Error('Aborted'));
        },
        { once: true }
      );
    });
  }
}
