/**
 * Router mode resolution — the single source of truth for which planner
 * backend is active.
 *
 * Mock routers exist for deterministic tests. They must never be reachable by
 * accident: normal `npm run dev` resolves to `omniroute`, every mock requires
 * an explicit opt-in flag, and mocks are refused outright in production.
 */

export type RouterMode = 'omniroute' | 'mock' | 'slow-mock' | 'failing-mock';

export const ROUTER_MODE_LABEL: Record<RouterMode, string> = {
  omniroute: 'OMNIROUTE',
  mock: 'MOCK',
  'slow-mock': 'SLOW MOCK',
  'failing-mock': 'FAILING MOCK',
};

/** True for any router that fabricates planner output instead of calling an LLM. */
export function isMockMode(mode: RouterMode): boolean {
  return mode !== 'omniroute';
}

/**
 * Resolve the active router mode from the environment.
 *
 * Precedence is fixed and narrow so two flags can never produce a surprise:
 *   failing-mock > slow-mock > mock > omniroute
 */
export function resolveRouterMode(env: NodeJS.ProcessEnv = process.env): RouterMode {
  const requested: RouterMode | null =
    env.USE_FAILING_MOCK_ROUTER === 'true'
      ? 'failing-mock'
      : env.USE_SLOW_MOCK_ROUTER === 'true'
        ? 'slow-mock'
        : env.USE_MOCK_ROUTER === 'true'
          ? 'mock'
          : null;

  if (!requested) return 'omniroute';

  // A stray test flag in a production build must not silently swap the agent
  // for a script that ignores the user's task.
  if (env.NODE_ENV === 'production') {
    console.error(
      `[router] Refusing mock router "${requested}" in production. Falling back to omniroute. ` +
        `Unset USE_MOCK_ROUTER / USE_SLOW_MOCK_ROUTER / USE_FAILING_MOCK_ROUTER.`
    );
    return 'omniroute';
  }

  console.warn(
    `[router] ⚠️  MOCK ROUTER ACTIVE: ${ROUTER_MODE_LABEL[requested]} — planner output is ` +
      `scripted, not from an LLM. Run plain \`npm run dev\` for the real agent.`
  );
  return requested;
}
