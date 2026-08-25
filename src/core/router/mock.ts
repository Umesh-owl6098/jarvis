/**
 * MockOmniRoute: Test implementation that returns predetermined actions.
 * Used for testing the agent loop without real LLM/API key dependencies.
 *
 * Simulates intelligent planning by returning appropriate actions based on task state.
 */

import { GenerateRequest, GenerateResponse } from './client';
import { destinationFromTask, mockRefusal } from './mock-slow';

export class MockOmniRoute {
  /** Destination taken from the real task, not hardcoded. */
  private destination: string | null = null;
  private callCount = 0;
  private taskState: Map<string, any> = new Map();
  private navigationDone = false;
  private extractionDone = false;

  async generate(request: GenerateRequest): Promise<GenerateResponse> {
    this.callCount++;
    const userMessage = request.messages.find(m => m.role === 'user')?.content || '';

    // Simulate token usage
    const inputTokens = Math.ceil(userMessage.length / 4);
    const outputTokens = 100;

    // Parse what the planner is asking for
    let action = this.generateAction(userMessage);

    // Debug: show what we're sending
    if (process.env.DEBUG) {
      console.log('[MOCK-LLM-DEBUG]', action);
    }

    return {
      content: action,
      model: 'mock-gpt-4',
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      provider: 'mock',
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
    strategy: 'cheap' | 'balanced' | 'capable' = 'balanced',
  ): Promise<GenerateResponse> {
    return this.generate(request);
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }

  private generateAction(userMessage: string): string {
    // Parse the context to understand current state
    let context: any = {};
    try {
      const jsonMatch = userMessage.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        context = JSON.parse(jsonMatch[0]);
      }
    } catch (e) {
      // If we can't parse, fall through to basic string checking
    }

    const url = context.currentPage?.url || '';
    const title = context.currentPage?.title || '';

    // Derive the destination from the real task so the mock never silently
    // navigates somewhere the user did not ask for.
    if (typeof context.task === 'string' && context.task) {
      this.destination = destinationFromTask(context.task);
    }
    if (!this.destination) {
      return JSON.stringify({
        action: 'fail',
        reason:
          'MOCK ROUTER: no destination could be read from the task. Mock routers do not ' +
          'reason about site names — run without USE_*_MOCK_ROUTER to use the real planner.',
      });
    }

    // Track state based on URL
    // State 1: At blank page, need to navigate
    if (!this.navigationDone && (url.includes('about:blank') || url === '')) {
      return JSON.stringify({
        action: 'use_skill',
        skillId: 'navigation',
        input: { url: this.destination },
        reasoning: `Task requires navigating to ${this.destination}, currently at blank page`,
      });
    }

    // Mark navigation as done once we see example.com
    if (!this.navigationDone && url && url !== 'about:blank') {
      this.navigationDone = true;
    }

    // State 2: At example.com, extract title
    if (this.navigationDone && !this.extractionDone) {
      this.extractionDone = true;
      return JSON.stringify({
        action: 'use_skill',
        skillId: 'extraction',
        input: { type: 'title' },
        reasoning: 'Page is loaded, extract the title as requested',
      });
    }

    // State 3: All done, finish
    if (this.navigationDone && this.extractionDone) {
      return JSON.stringify({
        action: 'finish',
        result: `Opened ${this.destination}${title ? ` — page title is "${title}"` : ''}.`,
      });
    }

    // Fallback
    return JSON.stringify({
      action: 'finish',
      result: 'Task completed',
    });
  }
}

export const mockOmniRoute = new MockOmniRoute();
