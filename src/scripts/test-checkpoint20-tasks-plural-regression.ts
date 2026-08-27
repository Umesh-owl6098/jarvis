/**
 * Checkpoint 20 — regression coverage for two real bugs found during live
 * verification against the real Google Tasks API:
 *
 * 1. UPDATE_VERB_RE/COMPLETE_VERB_RE/DELETE_VERB_RE originally required the
 *    singular word "task" with strict \b word boundaries, which never
 *    matches "Tasks" (plural) — so a command targeting a task whose OWN
 *    title contains "Tasks" (exactly this checkpoint's own
 *    "JARVIS Tasks Integration Test" naming convention) fell through to
 *    the generic browser capability entirely instead of being recognized
 *    as a Tasks intent at all.
 * 2. Even after that regex fix, stripTaskNoise() strips "task"/"tasks" out
 *    of the extracted search query — which broke the single-contiguous-
 *    substring match searchTasks() used to do, since the query no longer
 *    contained a word the real title does. Fixed by switching to
 *    AND-of-terms matching (mirroring calendar's own searchEvents), which
 *    only requires each query term to appear in the title, not vice versa.
 *
 * Exercised against the "JARVIS Tasks Regression Check" mock fixture,
 * which deliberately reproduces the real bug's shape.
 */
process.env.USE_MOCK_TASKS = 'true';

import { runTask } from '@/core/agent/task-manager';
import { detectTasksIntent } from '@/core/capabilities/tasks/intent';
import { tasksPendingActionStore } from '@/core/capabilities/tasks/pending-action';
import { nanoid } from 'nanoid';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

async function main() {
  // ---------- unit-level: the trigger regexes recognize "Tasks" (plural) in the target's own title ----------
  check(
    '1. "Mark JARVIS Tasks Regression Check complete." is recognized as a Tasks intent',
    detectTasksIntent('Mark JARVIS Tasks Regression Check complete.') !== null
  );
  check(
    '2. "Delete my JARVIS Tasks Regression Check task." is recognized as a Tasks intent',
    detectTasksIntent('Delete my JARVIS Tasks Regression Check task.') !== null
  );
  check(
    '3. "Change my JARVIS Tasks Regression Check task to Friday." is recognized as a Tasks intent',
    detectTasksIntent('Change my JARVIS Tasks Regression Check task to Friday.') !== null
  );

  // ---------- end-to-end: routes to the Tasks capability, not the generic browser fallback ----------
  {
    tasksPendingActionStore.clear();
    const r = await runTask({ goal: 'Mark JARVIS Tasks Regression Check complete.', onEvent: () => {}, taskId: nanoid() });
    check(
      '4. end-to-end: routes to capability=tasks (not browser), finds the single real match, proposes completion',
      r.capability?.selected === 'tasks' && /MARK COMPLETE — READY FOR CONFIRMATION/.test(r.result) && /JARVIS Tasks Regression Check/.test(r.result),
      `capability=${r.capability?.selected} result=${r.result.slice(0, 200)}`
    );
    tasksPendingActionStore.clear();
  }

  // ---------- AND-of-terms search still finds it even with "task(s)" stripped from the query ----------
  {
    const r = await runTask({ goal: 'Delete my JARVIS Tasks Regression Check task.', onEvent: () => {}, taskId: nanoid() });
    check(
      '5. delete proposal correctly targets the one real match, not "no matching task found"',
      /TASK DELETION READY FOR CONFIRMATION/.test(r.result) && /JARVIS Tasks Regression Check/.test(r.result),
      `result=${r.result.slice(0, 200)}`
    );
    tasksPendingActionStore.clear();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
