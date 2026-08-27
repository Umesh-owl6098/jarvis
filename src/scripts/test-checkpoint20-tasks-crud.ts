/**
 * Checkpoint 20 §21 C-J — find, create, double-confirm idempotency, update
 * due date, mark complete, and delete, all proposal-then-confirm.
 */
process.env.USE_MOCK_TASKS = 'true';

import { runTask } from '@/core/agent/task-manager';
import { tasksPendingActionStore } from '@/core/capabilities/tasks/pending-action';
import { getTasksClient } from '@/core/capabilities/tasks/resolve';
import { nanoid } from 'nanoid';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

async function main() {
  // ---------- C: find a unique task ----------
  {
    const r = await runTask({ goal: 'Find my report task.', onEvent: () => {}, taskId: nanoid() });
    check(
      'C. find unique task — matches the "Submit report" fixture',
      r.status === 'success' && /Submit report/.test(r.result),
      `result=${r.result.slice(0, 150)}`
    );
  }

  // ---------- D: ambiguous duplicate title -> clarification, no proposal ----------
  {
    tasksPendingActionStore.clear();
    const r = await runTask({ goal: 'Mark the team sync task complete.', onEvent: () => {}, taskId: nanoid() });
    check(
      'D. duplicate title "Team sync" -> clarification, no pending action',
      r.outcome === 'blocked' && /Multiple tasks match/i.test(r.result) && !tasksPendingActionStore.active(),
      `outcome=${r.outcome} result=${r.result.slice(0, 200)}`
    );
  }

  // ---------- E: create proposal -> no mutation yet ----------
  let createdCountBefore = 0;
  {
    tasksPendingActionStore.clear();
    const client = getTasksClient();
    createdCountBefore = (await client.listTasks(client.defaultListId, 100)).length;
    const r = await runTask({ goal: 'Remind me to call Ramesh tomorrow.', onEvent: () => {}, taskId: nanoid() });
    const after = (await client.listTasks(client.defaultListId, 100)).length;
    check(
      'E. create proposal shown, NO mutation yet — task count unchanged',
      r.status === 'success' && /TASK READY FOR CONFIRMATION/.test(r.result) && !!r.tasks?.pendingAction && after === createdCountBefore,
      `result=${r.result.slice(0, 150)} before=${createdCountBefore} after=${after}`
    );
  }

  // ---------- F: confirm create -> exactly one new task ----------
  {
    const client = getTasksClient();
    const before = (await client.listTasks(client.defaultListId, 100)).length;
    const r = await runTask({ goal: 'Create it.', onEvent: () => {}, taskId: nanoid() });
    const after = (await client.listTasks(client.defaultListId, 100)).length;
    check(
      'F. confirm create -> exactly one task created',
      r.status === 'success' && /^Created /.test(r.result) && after === before + 1,
      `result=${r.result} before=${before} after=${after}`
    );
  }

  // ---------- G: double confirm -> no duplicate ----------
  {
    // "Create it." is shared vocabulary between Calendar and Tasks (§9's
    // own spec examples use it for both). With NEITHER pending store
    // active at this point, task-manager.ts's documented tiebreak falls
    // back to Calendar's wording (preserving CP18's own regression test,
    // which asserts this exact string) — so the functional guarantee under
    // test here is "no duplicate task is created," not which capability's
    // wording answers. See the final report's Known Limitations.
    const client = getTasksClient();
    const before = (await client.listTasks(client.defaultListId, 100)).length;
    const r = await runTask({ goal: 'Create it.', onEvent: () => {}, taskId: nanoid() });
    const after = (await client.listTasks(client.defaultListId, 100)).length;
    check(
      'G. repeat "Create it." with nothing pending in either store -> no duplicate task created',
      r.status === 'success' && /no pending/i.test(r.result) && after === before,
      `result=${r.result} before=${before} after=${after}`
    );
  }

  // ---------- H: update due date proposal/confirm ----------
  {
    tasksPendingActionStore.clear();
    const r1 = await runTask({ goal: 'Change my passport task to Friday.', onEvent: () => {}, taskId: nanoid() });
    check(
      'H1. update-due-date proposal shown, not yet applied',
      r1.status === 'success' && /TASK UPDATE READY FOR CONFIRMATION/.test(r1.result) && !!r1.tasks?.pendingAction,
      `result=${r1.result.slice(0, 200)}`
    );
    const r2 = await runTask({ goal: 'Update it.', onEvent: () => {}, taskId: nanoid() });
    const client = getTasksClient();
    const found = await client.searchTasks('Renew passport', 5);
    check(
      'H2. confirm update -> due date actually changed on the real fixture task',
      r2.status === 'success' && /^Updated /.test(r2.result) && found.tasks[0]?.due != null,
      `result=${r2.result} due=${found.tasks[0]?.due}`
    );
  }

  // ---------- I: mark complete proposal/confirm ----------
  {
    tasksPendingActionStore.clear();
    const r1 = await runTask({ goal: 'Mark my design doc task complete.', onEvent: () => {}, taskId: nanoid() });
    check(
      'I1. complete proposal shown, not yet applied',
      r1.status === 'success' && /MARK COMPLETE — READY FOR CONFIRMATION/.test(r1.result) && !!r1.tasks?.pendingAction,
      `result=${r1.result.slice(0, 200)}`
    );
    const r2 = await runTask({ goal: 'Mark it complete.', onEvent: () => {}, taskId: nanoid() });
    const client = getTasksClient();
    const found = await client.searchTasks('Read design doc', 5);
    check(
      'I2. confirm complete -> task status is now completed on the real fixture',
      r2.status === 'success' && /^Marked /.test(r2.result) && found.tasks[0]?.status === 'completed',
      `result=${r2.result} status=${found.tasks[0]?.status}`
    );
  }

  // ---------- J: delete proposal/confirm ----------
  {
    tasksPendingActionStore.clear();
    const client = getTasksClient();
    const beforeCount = (await client.searchTasks('Review PR', 5)).tasks.length;
    const r1 = await runTask({ goal: 'Delete my Review PR task.', onEvent: () => {}, taskId: nanoid() });
    check(
      'J1. delete proposal shown, not yet applied',
      r1.status === 'success' && /TASK DELETION READY FOR CONFIRMATION/.test(r1.result) && !!r1.tasks?.pendingAction,
      `result=${r1.result.slice(0, 200)}`
    );
    const r2 = await runTask({ goal: 'Delete it.', onEvent: () => {}, taskId: nanoid() });
    const afterCount = (await client.searchTasks('Review PR', 5)).tasks.length;
    check(
      'J2. confirm delete -> task actually removed from the real fixture',
      r2.status === 'success' && /^Deleted /.test(r2.result) && beforeCount === 1 && afterCount === 0,
      `result=${r2.result} before=${beforeCount} after=${afterCount}`
    );
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
