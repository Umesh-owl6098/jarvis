/**
 * Checkpoint 16 §22 — real-world matrix, run through the ACTUAL production
 * entrypoint (task-manager.ts's runTask — the same path a real user request
 * takes: capability routing, deterministic decomposition, TaskPlan/executor)
 * rather than a hand-wired test harness, so the real NavigationEvidence +
 * CommittedTarget + goal-evaluator wiring is exercised end to end against
 * real destinations. Kept to 4 real tasks total, per "do not hammer websites."
 */

import { runTask } from '@/core/agent/task-manager';
import { nanoid } from 'nanoid';

const SID = 'test-session';

interface MatrixRow {
  name: string;
  status: string;
  outcome?: string;
  plannerCalls?: number;
  tokens?: number;
  durationMs: number;
  result: string;
}

const rows: MatrixRow[] = [];

async function run(name: string, goal: string): Promise<void> {
  const started = Date.now();
  const result = await runTask({ sessionId: SID, goal, onEvent: () => {}, taskId: nanoid() });
  rows.push({
    name,
    status: result.status,
    outcome: result.outcome,
    plannerCalls: result.plannerCalls,
    tokens: result.tokensUsed,
    durationMs: Date.now() - started,
    result: result.result.slice(0, 220),
  });
}

async function main() {
  // A. The exact multi-step SHAPE from Checkpoint 15's own verification task
  // (navigate -> search -> open the result -> extract, 4 real objectives,
  // a genuine cross-subgoal dependency resolved via CommittedTarget rather
  // than stale priorFacts). The literal original CP15 session string isn't
  // recoverable after context compaction; this reproduces the same task
  // shape/pattern for a fair architectural comparison.
  await run(
    'A. Wikipedia multi-step (navigate, search, open result, extract)',
    'Open wikipedia.org, search for OpenAI, open the result, and tell me the first sentence of the article.'
  );

  // B. GitHub repository task — real capability routing (read API first,
  // browser fallback), real destination.
  await run('B. GitHub repository task', 'Read the GitHub repository facebook/react README and tell me what the project is.');

  // C. One normal public navigation.
  await run('C. Normal public navigation', 'Open example.com and tell me the page title.');

  // D. One redirect — wikipedia.org bare domain issues a real redirect to
  // www.wikipedia.org (already proven in test-checkpoint16-navigation's real
  // navigation-domains re-run); exercised again here through the FULL
  // production path (capability routing + goal evaluator), not just
  // NavigationSkill directly.
  await run('D. Redirect (wikipedia.org -> www.wikipedia.org)', 'Open wikipedia.org and tell me the page title.');

  console.log('\n=== CHECKPOINT 16 REAL-WORLD MATRIX ===\n');
  for (const r of rows) {
    console.log(`--- ${r.name} ---`);
    console.log(`  status=${r.status} outcome=${r.outcome ?? 'n/a'} plannerCalls=${r.plannerCalls ?? 'n/a'} tokens=${r.tokens ?? 'n/a'} duration=${(r.durationMs / 1000).toFixed(1)}s`);
    console.log(`  result: ${r.result}`);
  }

  const anyFailed = rows.some((r) => r.status !== 'success');
  console.log(`\n${anyFailed ? '⚠️  Some real-world cases did not complete — see rows above' : '✅ All real-world matrix cases completed'}`);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
