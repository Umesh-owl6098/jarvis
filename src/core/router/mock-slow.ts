/**
 * SlowMockOmniRoute: Test-only slow implementation
 * Deliberately delays planner responses to allow UI interaction testing
 * Used ONLY when USE_SLOW_MOCK_ROUTER=true
 * NOT for production
 */

import { GenerateRequest, GenerateResponse } from './client';

/**
 * Extract an explicit destination from the user's task.
 *
 * Mocks are scripted, but they must never silently replace the destination the
 * user asked for — that turns a test fixture into a lie about what the agent
 * did. Returns null when the task names no domain, so callers can refuse
 * rather than invent one.
 */
export function mockRefusal(userMessage: string): GenerateResponse {
  const inputTokens = Math.ceil(userMessage.length / 4);
  return {
    content: JSON.stringify({
      action: 'fail',
      reason:
        'MOCK ROUTER: no destination could be read from the task. Mock routers do not ' +
        'reason about site names — run without USE_*_MOCK_ROUTER to use the real planner.',
    }),
    model: 'mock',
    inputTokens,
    outputTokens: 40,
    totalTokens: inputTokens + 40,
    provider: 'mock',
    cost: 0,
  };
}

export function destinationFromTask(task: string): string | null {
  const match = String(task ?? '').match(
    /\b((?:https?:\/\/)?(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?:\/[^\s]*)?)/i
  );
  if (!match) return null;
  const raw = match[1];
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}


interface GenerateWithSignalRequest extends GenerateRequest {
  signal?: AbortSignal;
}

export class SlowMockOmniRoute {
  private callCount = 0;
  private navigationDone = false;
  private extractionDone = false;
  private signal?: AbortSignal;
  /** Destination taken from the real task, not hardcoded. */
  private destination: string | null = null;

  constructor(signal?: AbortSignal) {
    this.signal = signal;
  }

  async generate(request: GenerateRequest): Promise<GenerateResponse> {
    this.callCount++;

    // Simulate slow planner with 5 second delay
    console.log(`[SLOW-MOCK] Planning call ${this.callCount}, delaying 5 seconds...`);
    await this.delay(5000, this.signal);
    console.log(`[SLOW-MOCK] Planning delay complete`);

    const userMessage = request.messages.find((m) => m.role === 'user')?.content || '';
    // The task text arrives inside the serialized context in the user prompt.
    const taskMatch = userMessage.match(/"task"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (taskMatch) this.destination = destinationFromTask(taskMatch[1]);
    if (!this.destination) {
      // Never invent a destination: say so instead of navigating somewhere the
      // user did not ask for. Real planning needs the LLM.
      return mockRefusal(userMessage);
    }
    const inputTokens = Math.ceil(userMessage.length / 4);
    const outputTokens = 100;

    // Return appropriate action based on state
    let action = this.generateAction();

    return {
      content: action,
      model: 'slow-mock-gpt-4',
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      provider: 'slow-mock',
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
    strategy: 'cheap' | 'balanced' | 'capable' = 'balanced'
  ): Promise<GenerateResponse> {
    return this.generate(request);
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }

  private generateAction(): string {
    // State 1: Navigate
    if (!this.navigationDone) {
      this.navigationDone = true;
      console.log(`[SLOW-MOCK] Returning navigate action`);
      return JSON.stringify({
        action: 'use_skill',
        skillId: 'navigation',
        input: { url: this.destination },
        reasoning: `Navigate to ${this.destination}`,
      });
    }

    // State 2: Extract and finish
    if (!this.extractionDone) {
      this.extractionDone = true;
      console.log(`[SLOW-MOCK] Returning extract action`);
      return JSON.stringify({
        action: 'use_skill',
        skillId: 'extraction',
        input: { type: 'title' },
        reasoning: 'Extract page title',
      });
    }

    // State 3: Finish
    console.log(`[SLOW-MOCK] Returning finish action`);
    return JSON.stringify({
      action: 'finish',
      result: `Opened ${this.destination} successfully.`,
    });
  }

  private delay(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }

      const timeout = setTimeout(resolve, ms);

      if (signal) {
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timeout);
            reject(new DOMException('Aborted', 'AbortError'));
          },
          { once: true }
        );
      }
    });
  }
}

export const slowMockOmniRoute = new SlowMockOmniRoute();
