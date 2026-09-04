/**
 * Checkpoint 29 §15 — read-only reminder queries require no confirmation:
 * ordered listing, "next reminder," empty state, and bounded output.
 */
const TEST_REMINDERS_PATH = require('os').tmpdir() + '/jarvis-cp29-reads-' + Date.now() + '.json';
process.env.JARVIS_REMINDERS_PATH = TEST_REMINDERS_PATH;

process.env.USE_MOCK_GMAIL = 'true';
process.env.USE_MOCK_CALENDAR = 'true';
process.env.USE_MOCK_TASKS = 'true';
process.env.USE_MOCK_CONTACTS = 'true';

import { runTask } from '@/core/agent/task-manager';
import { reminderStore } from '@/core/reminders/store';
import { reminderPendingActionStore } from '@/core/reminders/pending-action';
import { nanoid } from 'nanoid';
import type { Reminder } from '@/core/reminders/types';

const SID = 'test-session-a';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

function makeReminder(id: string, text: string, hoursOut: number): Reminder {
  return { id, text, triggerAt: new Date(Date.now() + hoursOut * 3600000).toISOString(), createdAt: new Date().toISOString(), status: 'scheduled' };
}

async function main() {
  reminderPendingActionStore.clear(SID);

  // ---------- 1. empty state ----------
  {
    const r = await runTask({ sessionId: SID, goal: 'What reminders do I have?', onEvent: () => {}, taskId: nanoid() });
    check('1. listing with zero scheduled reminders reports the honest empty state', r.result === "You don't have any scheduled reminders.", `result=${r.result}`);
    check('1b. no confirmation was required for a read', r.outcome === 'completed');
  }
  {
    const r = await runTask({ sessionId: SID, goal: "What's my next reminder?", onEvent: () => {}, taskId: nanoid() });
    check('2. "next" with zero scheduled reminders reports the honest empty state', r.result === "You don't have any scheduled reminders.", `result=${r.result}`);
  }

  // ---------- 3. ordered listing ----------
  {
    reminderStore.add(makeReminder('late', 'Late one', 5));
    reminderStore.add(makeReminder('early', 'Early one', 1));
    reminderStore.add(makeReminder('mid', 'Mid one', 3));
    const r = await runTask({ sessionId: SID, goal: 'Show my reminders.', onEvent: () => {}, taskId: nanoid() });
    const earlyIdx = r.result.indexOf('Early one');
    const midIdx = r.result.indexOf('Mid one');
    const lateIdx = r.result.indexOf('Late one');
    check('3. listing orders strictly by triggerAt ascending (earliest first)', earlyIdx >= 0 && earlyIdx < midIdx && midIdx < lateIdx, `result=${r.result}`);
    check('3b. no confirmation required for a read', r.outcome === 'completed');
    reminderStore.cancel('late'); reminderStore.cancel('early'); reminderStore.cancel('mid');
  }

  // ---------- 4. next reminder returns the nearest one ----------
  {
    reminderStore.add(makeReminder('n-late', 'Later item', 5));
    reminderStore.add(makeReminder('n-early', 'Nearest item', 1));
    const r = await runTask({ sessionId: SID, goal: "What's my next reminder?", onEvent: () => {}, taskId: nanoid() });
    check('4. "next" returns specifically the NEAREST scheduled reminder', r.result.includes('Nearest item') && !r.result.includes('Later item'), `result=${r.result}`);
    reminderStore.cancel('n-late'); reminderStore.cancel('n-early');
  }

  // ---------- 5. bounded history — listing never dumps unlimited entries ----------
  {
    const ids: string[] = [];
    for (let i = 0; i < 25; i++) {
      const id = `bound-${i}`;
      ids.push(id);
      reminderStore.add(makeReminder(id, `Bounded item ${i}`, 1 + i * 0.01));
    }
    const r = await runTask({ sessionId: SID, goal: 'List my reminders.', onEvent: () => {}, taskId: nanoid() });
    const lineCount = r.result.split('\n').filter((l) => /^\d+\./.test(l)).length;
    check('5. listing 25 scheduled reminders never dumps all 25 unbounded — output is capped', lineCount <= 20, `lineCount=${lineCount}`);
    check('5b. a truncation note is shown when the list is capped', /showing/i.test(r.result), `result=${r.result.slice(-100)}`);
    for (const id of ids) reminderStore.cancel(id);
  }

  // ---------- 6. cancelled/delivered reminders never appear in the default listing ----------
  {
    reminderStore.add(makeReminder('visible1', 'Should appear', 1));
    reminderStore.add(makeReminder('hidden1', 'Should NOT appear (will be cancelled)', 2));
    reminderStore.cancel('hidden1');
    const r = await runTask({ sessionId: SID, goal: 'Show my reminders.', onEvent: () => {}, taskId: nanoid() });
    check('6. listing shows only SCHEDULED reminders — cancelled ones are excluded', r.result.includes('Should appear') && !r.result.includes('Should NOT appear'), `result=${r.result}`);
    reminderStore.cancel('visible1');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  try { require('fs').rmSync(TEST_REMINDERS_PATH, { force: true }); } catch {}
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error('Fatal error:', e);
  try { require('fs').rmSync(TEST_REMINDERS_PATH, { force: true }); } catch {}
  process.exit(1);
});
