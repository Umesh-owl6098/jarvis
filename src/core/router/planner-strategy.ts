/**
 * Planner-specific routing.
 *
 * The planner needs one short, schema-valid AgentAction — not conversation.
 * Leaving it on OmniRoute's `auto` let it roam a pool that includes models
 * which degrade on realistic observations: benchmarked over 13 scenarios with
 * production-sized pages (40–60 elements) at temperature 0.7,
 * `nemotron-3-ultra-free` scored 21/26 with reasoning leakage, empty responses
 * and a length-stop, while `hy3-free` scored 50/52 with its only failures being
 * JSON truncated by the token cap.
 *
 * So: prefer a model that benchmarks well, keep a short fallback chain for
 * availability, and stop — cycling many free providers costs minutes.
 *
 * This is deliberately separate from future conversational / vision routing.
 * One model should not have to serve every JARVIS need.
 */

/** Ordered preference. First entry that answers wins. */
export const PLANNER_MODEL_CHAIN: string[] = (
  process.env.JARVIS_PLANNER_MODELS ||
  [
    'oc/hy3-free', // benchmarked best for structured output
    'auto', // OmniRoute routing keeps us working if the above is down
  ].join(',')
)
  .split(',')
  .map((m) => m.trim())
  .filter(Boolean);

/**
 * Zero. Measured, not assumed: across 26 scenarios the temperature dominated
 * output-size stability far more than model choice did —
 *   temp 0.7 -> completion tokens median 162, p90 648, max 924
 *   temp 0   -> completion tokens median 132, p90 167, max 213
 * The long tail at 0.7 is what pushed JSON past the cap and truncated it.
 */
export const PLANNER_TEMPERATURE = Number(process.env.JARVIS_PLANNER_TEMPERATURE ?? 0);

/**
 * Chosen from the observed distribution, not guessed.
 *
 * The action JSON itself is tiny (median 126 bytes, max 331), but total
 * completion length has a long tail: at a 512 cap two responses truncated at
 * exactly 512, and with a non-binding cap the observed max reached 778.
 * Earlier guesses of 500 and 900 both sat inside that tail.
 *
 * max_tokens is a ceiling, not a reservation — unused budget costs nothing —
 * so there is no reason to run tight. 1536 is ~2x the observed max and still
 * bounds a runaway generation.
 */
export const PLANNER_MAX_TOKENS = Number(process.env.JARVIS_PLANNER_MAX_TOKENS ?? 1536);

/** How many models to try before giving up, so a bad pool cannot stall a task. */
export const PLANNER_MAX_FALLBACKS = Number(process.env.JARVIS_PLANNER_MAX_FALLBACKS ?? 2);

export interface PlannerRoutingOutcome {
  /** Model requested from OmniRoute. */
  requested: string;
  /** Model OmniRoute actually served. */
  served: string | null;
  /** True when the first preference was skipped. */
  usedFallback: boolean;
  /** Models that failed before this one succeeded. */
  attempts: { model: string; error: string }[];
}
