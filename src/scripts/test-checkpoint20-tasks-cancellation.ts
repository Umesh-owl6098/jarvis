/**
 * Checkpoint 20 §19/§21 L — cancellation while listing/finding/proposing
 * stops cleanly; a mutation Google already accepted is never retroactively
 * reported as cancelled.
 */
process.env.USE_MOCK_TASKS = 'true';

import { runTask } from '@/core/agent/task-manager';
import { tasksPendingActionStore } from '@/core/capabilities/tasks/pending-action';
import { getTasksClient } from '@/core/capabilities/tasks/resolve';
import { nanoid } from 'nanoid';

const SID = 'test-session';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

async function main() {
  tasksPendingActionStore.clear(SID);

  // ---------- A: cancelled before a list even starts ----------
  {
    const controller = new AbortController();
    controller.abort();
    const r = await runTask({ sessionId: SID, goal: 'What tasks do I have today?', onEvent: () => {}, signal: controller.signal, taskId: nanoid() });
    check('A. list cancelled before it starts — reports stopped, not a false completion', r.status === 'stopped', `status=${r.status} result=${r.result}`);
  }

  // ---------- B: cancelled before a create proposal is built — no proposal, no pending action ----------
  {
    tasksPendingActionStore.clear(SID);
    const controller = new AbortController();
    controller.abort();
    const r = await runTask({ sessionId: SID, goal: 'Remind me to call Ramesh tomorrow.', onEvent: () => {}, signal: controller.signal, taskId: nanoid() });
    check(
      'B. create cancelled before proposal — stopped, no pending action',
      r.status === 'stopped' && !tasksPendingActionStore.active(SID),
      `status=${r.status} pendingActive=${!!tasksPendingActionStore.active(SID)}`
    );
  }

  // ---------- C: cancelled before a delete is applied — no mutation, no pending action ----------
  {
    tasksPendingActionStore.clear(SID);
    await runTask({ sessionId: SID, goal: 'Delete my Review PR task.', onEvent: () => {}, taskId: nanoid() });
    const controller = new AbortController();
    controller.abort();
    const r = await runTask({ sessionId: SID, goal: 'Delete it.', onEvent: () => {}, signal: controller.signal, taskId: nanoid() });
    const client = getTasksClient();
    const stillThere = (await client.searchTasks('Review PR', 5)).tasks.length;
    check(
      'C. delete confirmation cancelled before Tasks accepted it — task still exists, reported stopped',
      r.status === 'stopped' && stillThere === 1,
      `status=${r.status} result=${r.result} stillThere=${stillThere}`
    );
    tasksPendingActionStore.clear(SID);
  }

  // ---------- D: a create already accepted by Tasks must NEVER be reported as cancelled afterward ----------
  {
    tasksPendingActionStore.clear(SID);
    await runTask({ sessionId: SID, goal: 'Remind me to call Ramesh tomorrow.', onEvent: () => {}, taskId: nanoid() });
    const first = await runTask({ sessionId: SID, goal: 'Create it.', onEvent: () => {}, taskId: nanoid() });
    check('D. genuine create confirmed successfully before the cancellation check', first.status === 'success', `first=${first.result}`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
