import axios, { AxiosInstance } from 'axios';

import { routerRuntime } from './runtime-status';
import {
  PLANNER_MODEL_CHAIN,
  PLANNER_TEMPERATURE,
  PLANNER_MAX_TOKENS,
  PLANNER_MAX_FALLBACKS,
  type PlannerRoutingOutcome,
} from './planner-strategy';

export type OmniRouteHealthStatus = 'connected' | 'rate_limited' | 'unavailable';

export interface OmniRouteHealthResult {
  status: OmniRouteHealthStatus;
  reachable: boolean;
  checkedAt: string;
  latencyMs: number;
}

export interface LLMMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface GenerateRequest {
  model?: string;
  messages: LLMMessage[];
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
}

export interface GenerateResponse {
  content: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  provider: string;
  cost: number;
}

const RATE_LIMIT_EXPIRY_MS = 60_000;

export class OmniRouteClient {
  private client: AxiosInstance;
  private baseUrl: string;
  private apiKey: string;
  private maxRetries = 3;
  private retryDelayMs = 1000;
  private lastRateLimitAt: number = 0;

  constructor(baseUrl?: string, apiKey?: string) {
    this.baseUrl = baseUrl || process.env.OMNIROUTE_BASE_URL || 'http://localhost:20128';
    this.apiKey = apiKey || process.env.OMNIROUTE_API_KEY || '';

    this.client = axios.create({
      baseURL: this.baseUrl,
      headers: {
        'Content-Type': 'application/json',
        ...(this.apiKey && { Authorization: `Bearer ${this.apiKey}` }),
      },
      timeout: 60000,
    });
  }

  /**
   * Check if error is transient and retryable.
   */
  private isTransientError(status: number): boolean {
    // Transient errors that we should retry on
    return status === 429 || status === 502 || status === 503 || status === 504;
  }

  /**
   * Implement exponential backoff with jitter.
   *
   * Post-CP23 fix — abortable: previously a plain setTimeout with no way
   * for a caller's AbortSignal to interrupt it, so an abort arriving during
   * the backoff delay (between retry attempts) had no effect until the
   * delay finished on its own.
   */
  private async waitBeforeRetry(attempt: number, signal?: AbortSignal): Promise<void> {
    // Exponential backoff: 1s, 2s, 4s + random jitter (0-1s)
    const baseDelay = this.retryDelayMs * Math.pow(2, attempt - 1);
    const jitter = Math.random() * 1000;
    const totalDelay = baseDelay + jitter;
    await new Promise<void>((resolve, reject) => {
      if (signal?.aborted) { reject(new DOMException('Cancelled', 'AbortError')); return; }
      const timer = setTimeout(resolve, totalDelay);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new DOMException('Cancelled', 'AbortError'));
      }, { once: true });
    });
  }

  /**
   * Generate text using OmniRoute (OpenAI-compatible API).
   * Includes retry logic for transient failures.
   *
   * Post-CP23 fix — `signal` is now threaded all the way into the actual
   * HTTP request (axios' native `signal` support) instead of being dropped
   * before reaching this layer. Previously an in-flight request here could
   * not be interrupted by the caller's AbortSignal at all — pressing Abort
   * only took effect at the NEXT `signal.throwIfAborted()` checkpoint in
   * executor.ts, which meant waiting for this call (and its own retries,
   * each up to the 60s axios timeout) to finish on its own first. A
   * cancellation is also never retried — `axios.isCancel()`/an aborted
   * signal short-circuits straight to a rethrow, never re-entering the
   * transient-error retry path below (which would otherwise treat the
   * resulting `status === undefined` as "maybe worth retrying").
   */
  async generate(request: GenerateRequest, signal?: AbortSignal): Promise<GenerateResponse> {
    const url = `${this.baseUrl}/api/v1/chat/completions`;
    let lastError: any = null;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      try {
        const response = await this.client.post(url, {
          model: request.model || 'auto', // Let OmniRoute choose
          messages: request.messages,
          temperature: request.temperature ?? 0.7,
          max_tokens: request.maxTokens ?? 2048,
          stream: request.stream ?? false,
        }, { signal });

        const data = response.data.choices[0].message;
        const usage = response.data.usage;

        // Handle both regular content and reasoning_content
        let content = data.content || data.reasoning_content || '';

        this.lastRateLimitAt = 0;

        const result = {
          content,
          model: response.data.model,
          inputTokens: usage.prompt_tokens,
          outputTokens: usage.completion_tokens,
          totalTokens: usage.total_tokens,
          provider: response.data.provider || 'oc',
          cost: 0,
        };

        console.log(`[OmniRoute] Plan call: ${result.inputTokens}in + ${result.outputTokens}out = ${result.totalTokens}total tokens`);

        // Real generation succeeded — this is what makes the HUD say ONLINE,
        // and it clears any stale transient state.
        routerRuntime.recordSuccess({ model: result.model, provider: result.provider });

        return result;
      } catch (error: any) {
        // A deliberate cancellation (ours or the caller's) is never a
        // "transient" failure worth retrying — axios reports it with no
        // `error.response`, which would otherwise look exactly like a
        // network blip (`status === undefined`, retried below). Checked
        // FIRST, before that generic branch ever sees it.
        if (signal?.aborted || axios.isCancel(error)) {
          throw new DOMException('Cancelled', 'AbortError');
        }

        lastError = error;
        const status = error.response?.status;

        // Don't retry on permanent errors
        if (status && !this.isTransientError(status)) {
          console.error(`[OmniRoute] Permanent error (${status}): ${error.response?.data?.error?.message}`);
          routerRuntime.recordFailure(status);
          throw new Error(`OmniRoute generation failed: ${error.message}`);
        }

        if (status === 429) {
          this.lastRateLimitAt = Date.now();
        }

        // Retry on transient errors
        if (attempt < this.maxRetries && (status === undefined || this.isTransientError(status))) {
          const waitMs = Math.round(this.retryDelayMs * Math.pow(2, attempt - 1));
          console.warn(`[OmniRoute] Attempt ${attempt}/${this.maxRetries} failed (${status}). Retrying in ${waitMs}ms...`);
          await this.waitBeforeRetry(attempt, signal);
          continue;
        }

        // Max retries exhausted. Rate limiting is the common, recoverable case
        // and deserves a message a user can act on rather than "status code 429".
        routerRuntime.recordFailure(status);
        if (status === 429) {
          throw new Error(
            `OmniRoute rate limited: all upstream providers returned 429 after ${this.maxRetries} attempts. ` +
              `Planning is temporarily unavailable — retry shortly.`
          );
        }

        // A refused socket means the service is not running at all. Lead with
        // that in plain language; the raw errno stays appended for Diagnostics
        // rather than becoming the headline the operator reads.
        const raw = String(error.message || '');
        if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET/i.test(raw)) {
          throw new Error(
            `OmniRoute offline: JARVIS cannot reach its planning service at ${this.baseUrl}. ` +
              `Start it with \`npx omniroute serve --no-open --daemon\`. (${raw})`
          );
        }
        throw new Error(`OmniRoute generation failed after ${this.maxRetries} attempts: ${raw}`);
      }
    }

    throw lastError || new Error('OmniRoute generation failed');
  }

  /**
   * Generate with routing hints for cost/capability balance.
   * This allows strategic model selection.
   *
   * For test environment without configured external providers,
   * use the simple 'auto' model which uses OmniRoute's internal providers.
   */
  async generateWithStrategy(
    request: GenerateRequest,
    strategy: 'cheap' | 'balanced' | 'capable' = 'balanced',
  ): Promise<GenerateResponse> {
    // Use simple 'auto' to avoid rate limits on free tier external providers
    return this.generate({
      ...request,
      model: 'auto', // Let OmniRoute choose based on internal providers
    });
  }

  /** Last planner routing outcome, for Developer Inspector / diagnostics. */
  lastPlannerRouting: PlannerRoutingOutcome | null = null;

  /**
   * Generate a planner action.
   *
   * Walks a short preferred-model chain rather than delegating to `auto`, so
   * the planner is not silently handed a model that leaks reasoning into
   * `content`. Bounded by PLANNER_MAX_FALLBACKS so a degraded provider pool
   * cannot stall a task for minutes.
   *
   * Post-CP23 fix — `signal` now flows through to every `generate()` call
   * in the chain, and an abort stops the fallback walk immediately rather
   * than trying the next model — a deliberate cancellation is not "this
   * model failed, try another."
   */
  async generateForPlanning(request: GenerateRequest, signal?: AbortSignal): Promise<GenerateResponse> {
    const chain = PLANNER_MODEL_CHAIN.slice(0, Math.max(1, PLANNER_MAX_FALLBACKS));
    const attempts: { model: string; error: string }[] = [];

    for (let i = 0; i < chain.length; i++) {
      if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      const model = chain[i];
      try {
        const response = await this.generate({
          ...request,
          model,
          temperature: request.temperature ?? PLANNER_TEMPERATURE,
          maxTokens: request.maxTokens ?? PLANNER_MAX_TOKENS,
        }, signal);
        this.lastPlannerRouting = {
          requested: model,
          served: response.model ?? null,
          usedFallback: i > 0,
          attempts,
        };
        if (i > 0) {
          console.log(`[Planner routing] fell back to "${model}" (served: ${response.model})`);
        }
        return response;
      } catch (error: any) {
        if (signal?.aborted || error?.name === 'AbortError') throw error; // never fall back after a deliberate cancel
        const message = String((error as Error).message || error).split('\n')[0].slice(0, 160);
        attempts.push({ model, error: message });
        console.log(`[Planner routing] "${model}" failed: ${message}`);
        if (i === chain.length - 1) {
          this.lastPlannerRouting = { requested: model, served: null, usedFallback: i > 0, attempts };
          throw error;
        }
      }
    }
    throw new Error('Planner routing exhausted with no models configured');
  }

  async healthCheck(): Promise<boolean> {
    const result = await this.getHealthStatus();
    return result.reachable;
  }

  async getHealthStatus(): Promise<OmniRouteHealthResult> {
    const start = Date.now();
    try {
      await this.client.get('/v1/models', { timeout: 5000 });
      const latencyMs = Date.now() - start;

      const recentlyRateLimited =
        this.lastRateLimitAt > 0 &&
        (Date.now() - this.lastRateLimitAt) < RATE_LIMIT_EXPIRY_MS;

      return {
        status: recentlyRateLimited ? 'rate_limited' : 'connected',
        reachable: true,
        checkedAt: new Date().toISOString(),
        latencyMs,
      };
    } catch {
      return {
        status: 'unavailable',
        reachable: false,
        checkedAt: new Date().toISOString(),
        latencyMs: Date.now() - start,
      };
    }
  }
}

export const omnirouteClient = new OmniRouteClient();
