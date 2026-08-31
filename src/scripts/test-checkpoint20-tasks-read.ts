/**
 * Checkpoint 20 §21 A/B — Tasks read operations: list today's/tomorrow's
 * tasks, list task lists, plain list, and routing (browser-nav guard).
 */
process.env.USE_MOCK_TASKS = 'true';

import { runTask } from '@/core/agent/task-manager';
import { detectTasksIntent } from '@/core/capabilities/tasks/intent';
import { nanoid } from 'nanoid';

const SID = 'test-session';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

async function main() {
  // ---------- A: list today's tasks ----------
  {
    const r = await runTask({ sessionId: SID, goal: 'What tasks do I have today?', onEvent: () => {}, taskId: nanoid() });
    check(
      'A. list today\'s tasks — completes via Tasks capability, shows the due-today fixture',
      r.status === 'success' && r.capability?.selected === 'tasks' && /Submit report/.test(r.result),
      `capability=${r.capability?.selected} result=${r.result.slice(0, 200)}`
    );
  }

  // ---------- B: list tomorrow's tasks ----------
  {
    const r = await runTask({ sessionId: SID, goal: 'What do I need to do tomorrow?', onEvent: () => {}, taskId: nanoid() });
    check(
      'B. list tomorrow\'s tasks — shows the due-tomorrow fixtures, not today\'s',
      r.status === 'success' && r.capability?.selected === 'tasks' && /Call Ramesh/.test(r.result) && !/Submit report/.test(r.result),
      `result=${r.result.slice(0, 200)}`
    );
  }

  // ---------- list task lists ----------
  {
    const r = await runTask({ sessionId: SID, goal: 'List my task lists.', onEvent: () => {}, taskId: nanoid() });
    check(
      'list task lists — shows both fixture lists',
      r.status === 'success' && /My Tasks/.test(r.result) && /Work/.test(r.result),
      `result=${r.result.slice(0, 150)}`
    );
  }

  // ---------- plain "show my tasks" (default list, active only) ----------
  {
    const r = await runTask({ sessionId: SID, goal: 'Show my tasks.', onEvent: () => {}, taskId: nanoid() });
    check(
      'plain list — shows active tasks, excludes the completed fixture',
      r.status === 'success' && !/Buy groceries/.test(r.result),
      `result=${r.result.slice(0, 250)}`
    );
  }

  // ---------- routing: "Open Google Tasks" / "Open tasks.google.com" never claimed by the Tasks capability ----------
  {
    check('ROUTING. "Open tasks.google.com" is not a Tasks intent', detectTasksIntent('Open tasks.google.com') === null);
    check('ROUTING. "Open Google Tasks" is not a Tasks intent', detectTasksIntent('Open Google Tasks') === null);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
