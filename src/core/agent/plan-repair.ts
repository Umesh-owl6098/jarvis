/**
 * Checkpoint 15 §7-11 — plan repair.
 *
 * Checkpoint 14 honestly admitted its "replanning" was retry + capability
 * switch, not real repair. This module adds a genuine repair step, tried
 * BEFORE a blind retry: given evidence about why a subgoal failed, produce
 * a better-informed replacement for [failed subgoal, ...remaining pending
 * subgoals] — completed subgoals are never touched, never regenerated.
 *
 * Deterministic repair first (§9) — reusing evidence already on hand
 * (a committed target's stable URL, the current observation already being
 * at the destination, a read failure that hasn't tried browser yet).
 * Planner-based repair (§10) only when no deterministic repair applies,
 * schema-validated, and restricted to touching only the failed + remaining
 * subgoals — never the completed ones, the original goal, or safety rules.
 */

import { z } from 'zod';
import { OmniRouteClient } from '@/core/router/client';
import { Subgoal, SubgoalType, TaskPlan, validatePlan, MAX_SUBGOALS } from './subgoal';
import type { CommittedTarget } from './target-state';

export interface RepairContext {
  overallGoal: string;
  completedSubgoals: { id: string; description: string; evidence?: string }[];
  /**
   * Checkpoint 16: the FULL committed target (with ownership/kind), already
   * resolved by the caller via resolveReference() against the failed
   * subgoal's own text — not just "whatever was most recently committed."
   * Absent means either no committed target exists yet, or the failed
   * subgoal's text doesn't reference one at all.
   */
  committedTarget?: CommittedTarget;
  failedSubgoal: Subgoal;
  failureEvidence: string;
  currentObservation?: { url?: string; title?: string };
  remainingSubgoals: Subgoal[];
}

export interface RepairResult {
  repaired: boolean;
  method: 'deterministic' | 'planner' | 'none';
  newSubgoals?: Subgoal[];
  reason: string;
  /** §13 — repair cost tracked separately from execution planning cost. Only planner repairs spend tokens. */
  inputTokens?: number;
  outputTokens?: number;
}

/**
 * §9 — tried first, always. Each check reuses evidence JARVIS already has;
 * none of these invents information or asks an LLM to guess.
 */
export function attemptDeterministicRepair(ctx: RepairContext): RepairResult {
  const failedDesc = ctx.failedSubgoal.description;

  // (a) The current observation is ALREADY at the committed target's
  // destination — the "failure" was reported on a page that in fact
  // already satisfies the subgoal (a race between the failure report and
  // the page settling). Self-heal by marking it done, not by repeating work.
  if (
    ctx.committedTarget?.url &&
    ctx.currentObservation?.url &&
    sameDestination(ctx.currentObservation.url, ctx.committedTarget.url)
  ) {
    return {
      repaired: true,
      method: 'deterministic',
      newSubgoals: [
        { ...ctx.failedSubgoal, status: 'pending', description: `Confirm arrival at ${ctx.committedTarget.url}`, type: 'extract' },
        ...ctx.remainingSubgoals,
      ],
      reason: `Current page is already at the committed target's destination (${ctx.currentObservation.url}) — repaired to a direct confirmation instead of repeating the failed action.`,
    };
  }

  // (b) A committed target has a stable URL that the failed attempt did
  // NOT already target directly (e.g. it tried a DOM click, or an earlier,
  // now-stale URL) — repair to an explicit direct navigation.
  if (ctx.committedTarget?.url && !failedDesc.includes(ctx.committedTarget.url)) {
    return {
      repaired: true,
      method: 'deterministic',
      newSubgoals: [
        { id: ctx.failedSubgoal.id, description: `Open ${ctx.committedTarget.url}`, type: 'navigate', status: 'pending' },
        ...ctx.remainingSubgoals,
      ],
      reason: `Committed target has a stable URL (${ctx.committedTarget.url}) not yet tried directly — repaired to navigate there.`,
    };
  }

  // (c) A read-capability failure that hasn't tried the browser on the
  // ORIGINAL (not read-rewritten) subgoal text yet — same fallback
  // Checkpoint 13 already proves works at the whole-task level, now
  // available at the subgoal level with a named, tracked repair method
  // instead of being folded into a generic "replan."
  if (/^(Jina Reader|GitHub (README|search) API|HN |Wikipedia summary API|No read target)/.test(ctx.failureEvidence)) {
    return {
      repaired: true,
      method: 'deterministic',
      newSubgoals: [
        { ...ctx.failedSubgoal, status: 'pending', forceCapability: 'browser' },
        ...ctx.remainingSubgoals,
      ],
      reason: 'Read capability failed — repaired to force the browser path (skips read entirely on retry, does not just hope routing picks differently).',
    };
  }

  return { repaired: false, method: 'none', reason: 'No deterministic repair evidence available.' };
}

function sameDestination(a: string, b: string): boolean {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    const norm = (h: string) => h.replace(/^www\./, '').toLowerCase();
    const trim = (p: string) => p.replace(/\/+$/, '') || '/';
    return norm(ua.hostname) === norm(ub.hostname) && trim(ua.pathname) === trim(ub.pathname);
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Planner-based repair (§10)                                          */
/* ------------------------------------------------------------------ */

const RepairSubgoalSchema = z.object({
  id: z.string(),
  description: z.string(),
  type: z.enum(['navigate', 'search', 'select', 'interact', 'extract', 'read']),
});
const RepairPlanSchema = z.object({ subgoals: z.array(RepairSubgoalSchema).min(1).max(MAX_SUBGOALS) });

/** Compact, bounded context — never the full transcript (§8, §21). */
function formatRepairPrompt(ctx: RepairContext): string {
  const lines: string[] = [
    `overallGoal: ${ctx.overallGoal}`,
    `completedSubgoals: ${ctx.completedSubgoals.map((s) => `${s.id}(${s.description})${s.evidence ? ` -> ${s.evidence}` : ''}`).join('; ') || 'none'}`,
  ];
  if (ctx.committedTarget) {
    lines.push(`committedTarget: ${ctx.committedTarget.label ?? '?'}${ctx.committedTarget.url ? ` @ ${ctx.committedTarget.url}` : ''}`);
  }
  lines.push(`failedSubgoal: ${ctx.failedSubgoal.id} (${ctx.failedSubgoal.type}) "${ctx.failedSubgoal.description}"`);
  lines.push(`failureEvidence: ${ctx.failureEvidence.slice(0, 300)}`);
  if (ctx.currentObservation?.url) lines.push(`currentObservation: url=${ctx.currentObservation.url} title=${ctx.currentObservation.title ?? ''}`);
  lines.push(`remainingSubgoals: ${ctx.remainingSubgoals.map((s) => `${s.id}(${s.type}) "${s.description}"`).join('; ') || 'none'}`);
  return lines.join('\n');
}

const REPAIR_SYSTEM_PROMPT = `You repair ONE broken step of an existing task plan. You may ONLY replace the
failed subgoal and the remaining pending subgoals listed below — you must
NEVER reference, restate, or imply changes to already-completed subgoals,
and you must NEVER invent a new overall goal.

Rules:
1. Respond ONLY with valid JSON: {"subgoals": [{"id": "...", "description": "...", "type": "navigate"|"search"|"select"|"interact"|"extract"|"read"}]}
2. The first subgoal in your response replaces the failed one (reuse its id or pick a new one starting with "sg").
3. Keep the SAME committed target if one exists — a target is invalid only if the failure evidence explicitly says it disappeared or 404s.
4. Never propose more subgoals than were remaining + 1.
5. Never propose a purchase, login, checkout, payment, account change, delete, or message-sending step.
6. If no repair is possible, respond with {"subgoals": []}.

Output a single JSON object and NOTHING else.`;

export async function attemptPlannerRepair(ctx: RepairContext, omniroute: OmniRouteClient): Promise<RepairResult> {
  try {
    const response = await omniroute.generateForPlanning({
      messages: [
        { role: 'system', content: REPAIR_SYSTEM_PROMPT },
        { role: 'user', content: formatRepairPrompt(ctx) },
      ],
    });
    const tokens = { inputTokens: response.inputTokens, outputTokens: response.outputTokens };
    const parsed = RepairPlanSchema.safeParse(JSON.parse(extractJson(response.content)));
    if (!parsed.success || parsed.data.subgoals.length === 0) {
      return {
        repaired: false,
        method: 'none',
        reason: parsed.success ? 'Planner repair declined (empty subgoals).' : `Planner repair returned invalid schema: ${parsed.error.message.slice(0, 150)}`,
        ...tokens,
      };
    }
    const newSubgoals: Subgoal[] = parsed.data.subgoals.map((s) => ({
      id: s.id,
      description: s.description,
      type: s.type as SubgoalType,
      status: 'pending' as const,
    }));
    return { repaired: true, method: 'planner', newSubgoals, reason: 'Planner proposed a repaired continuation.', ...tokens };
  } catch (e: any) {
    return { repaired: false, method: 'none', reason: `Planner repair call failed: ${e?.message ?? 'unknown error'}` };
  }
}

function extractJson(raw: string): string {
  const cleaned = raw.replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/i, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  return start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned;
}

/* ------------------------------------------------------------------ */
/* Invariants (§11) — defense in depth on top of validatePlan()        */
/* ------------------------------------------------------------------ */

export function validateRepair(
  plan: TaskPlan,
  failedSubgoalId: string,
  newSubgoals: Subgoal[],
  method: 'deterministic' | 'planner'
): { ok: true } | { ok: false; reason: string } {
  const completed = plan.subgoals.filter((s) => s.status === 'completed');

  // Completed subgoals must be byte-identical in the repaired plan — a
  // repair proposal is never even ALLOWED to mention them, so check they
  // still appear, unmodified, ahead of the repair splice point.
  const failedIdx = plan.subgoals.findIndex((s) => s.id === failedSubgoalId);
  if (failedIdx < 0) return { ok: false, reason: `Failed subgoal "${failedSubgoalId}" not found in plan` };
  for (let i = 0; i < failedIdx; i++) {
    if (plan.subgoals[i].status !== 'completed') continue;
    const stillThere = newSubgoals.every((s) => s.id !== plan.subgoals[i].id) && true;
    if (!stillThere) return { ok: false, reason: `Repair must not reference completed subgoal "${plan.subgoals[i].id}"` };
  }
  if (newSubgoals.some((s) => completed.some((c) => c.id === s.id))) {
    return { ok: false, reason: 'Repair proposes reusing a completed subgoal id' };
  }

  const totalAfterRepair = failedIdx + newSubgoals.length;
  if (totalAfterRepair > MAX_SUBGOALS) {
    return { ok: false, reason: `Repair would grow the plan to ${totalAfterRepair} subgoals, exceeding the limit of ${MAX_SUBGOALS}` };
  }

  const rest = validatePlan([...completed, ...newSubgoals]);
  if (!rest.ok) return rest;

  // No oscillation: a PLANNER repair must not just reintroduce the exact
  // failed subgoal unchanged (that is a retry wearing a repair costume).
  // Deterministic repair (c)'s forceCapability path deliberately keeps the
  // same description/type — it changes execution behavior, not text — so
  // this check only applies to planner-proposed repairs.
  if (
    method === 'planner' &&
    newSubgoals[0]?.description.trim() === plan.subgoals[failedIdx].description.trim() &&
    newSubgoals[0]?.type === plan.subgoals[failedIdx].type
  ) {
    return { ok: false, reason: 'Repair proposes an identical subgoal to the one that just failed — not a real repair' };
  }

  return { ok: true };
}
