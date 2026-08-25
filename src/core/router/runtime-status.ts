/**
 * Shared, in-process record of what real generation calls actually did.
 *
 * Reachability and generation capacity are different facts. `/v1/models`
 * answering in 20ms says nothing about whether planning works — the provider
 * pool can be returning 429 on every completion while the health probe stays
 * green. Reporting that as ONLINE is misleading, so generation outcomes are
 * recorded here and merged into the health response.
 *
 * Process memory only; no database. Stashed on globalThis so Next's dev HMR
 * cannot silently give the health route and the task route separate copies.
 */

export type GenerationState = 'unknown' | 'healthy' | 'rate_limited' | 'degraded' | 'unavailable';

/** What the UI displays. */
export type RouterStatus = 'checking' | 'online' | 'rate_limited' | 'degraded' | 'offline';

export interface RouterRuntimeSnapshot {
  lastGenerationState: GenerationState;
  lastGenerationAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastHttpStatus: number | null;
  lastModel: string | null;
  lastProvider: string | null;
}

/**
 * How long a transient failure keeps colouring the status. Long enough to be
 * visible after a failed task, short enough that the badge recovers on its own
 * rather than sticking amber forever.
 */
export const TRANSIENT_TTL_MS = 90_000;

interface Store {
  state: GenerationState;
  generationAt: number | null;
  successAt: number | null;
  failureAt: number | null;
  httpStatus: number | null;
  model: string | null;
  provider: string | null;
}

const KEY = '__jarvis_router_runtime__';

function store(): Store {
  const g = globalThis as unknown as Record<string, Store | undefined>;
  if (!g[KEY]) {
    g[KEY] = {
      state: 'unknown',
      generationAt: null,
      successAt: null,
      failureAt: null,
      httpStatus: null,
      model: null,
      provider: null,
    };
  }
  return g[KEY]!;
}

/** Classify an HTTP status from a failed generation call. */
export function classifyGenerationFailure(status?: number): GenerationState {
  if (status === 429) return 'rate_limited';
  if (status === 502 || status === 503 || status === 504) return 'degraded';
  // No status at all means we never reached the service (ECONNREFUSED, DNS…).
  if (status === undefined) return 'unavailable';
  return 'degraded';
}

export const routerRuntime = {
  /** A generation call succeeded — this clears any stale transient state. */
  recordSuccess(info: { model?: string | null; provider?: string | null } = {}): void {
    const s = store();
    const now = Date.now();
    s.state = 'healthy';
    s.generationAt = now;
    s.successAt = now;
    s.httpStatus = 200;
    if (info.model) s.model = info.model;
    if (info.provider) s.provider = info.provider;
  },

  /** A generation call failed for good (after the client's own retries). */
  recordFailure(status?: number): void {
    const s = store();
    const now = Date.now();
    s.state = classifyGenerationFailure(status);
    s.generationAt = now;
    s.failureAt = now;
    s.httpStatus = status ?? null;
  },

  /**
   * Current generation state, with transient failures ageing out. A success
   * newer than the last failure always wins.
   */
  currentState(now = Date.now()): GenerationState {
    const s = store();
    if (s.state === 'unknown' || s.state === 'healthy') return s.state;
    if (s.successAt && s.failureAt && s.successAt > s.failureAt) return 'healthy';
    if (s.generationAt && now - s.generationAt > TRANSIENT_TTL_MS) return 'unknown';
    return s.state;
  },

  snapshot(): RouterRuntimeSnapshot {
    const s = store();
    const iso = (t: number | null) => (t ? new Date(t).toISOString() : null);
    return {
      lastGenerationState: this.currentState(),
      lastGenerationAt: iso(s.generationAt),
      lastSuccessAt: iso(s.successAt),
      lastFailureAt: iso(s.failureAt),
      lastHttpStatus: s.httpStatus,
      lastModel: s.model,
      lastProvider: s.provider,
    };
  },

  /** Test helper. */
  reset(): void {
    const g = globalThis as unknown as Record<string, Store | undefined>;
    g[KEY] = undefined;
  },
};

/**
 * Merge reachability with observed generation capacity into the single status
 * the HUD renders.
 */
export function resolveRouterStatus(reachable: boolean, generation: GenerationState): RouterStatus {
  if (!reachable) return 'offline';
  switch (generation) {
    case 'rate_limited':
      return 'rate_limited';
    case 'degraded':
      return 'degraded';
    case 'unavailable':
      // Service was reachable just now but generation could not connect at all.
      return 'degraded';
    case 'healthy':
    case 'unknown':
    default:
      return 'online';
  }
}

export function isGenerationAvailable(status: RouterStatus): boolean {
  return status === 'online';
}
