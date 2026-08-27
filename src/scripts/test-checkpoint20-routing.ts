/**
 * Checkpoint 20 §14/§15/§21 M/N — the critical Calendar-vs-Tasks and
 * Gmail-body-vs-Tasks routing distinctions, tested both at the unit level
 * (detectXIntent directly — fast, no side effects) and end-to-end through
 * runTask() for the capability actually selected.
 */
process.env.USE_MOCK_TASKS = 'true';
process.env.USE_MOCK_CALENDAR = 'true';
process.env.USE_MOCK_GMAIL = 'true';

import { detectCalendarIntent } from '@/core/capabilities/calendar/intent';
import { detectTasksIntent } from '@/core/capabilities/tasks/intent';
import { detectGmailIntent } from '@/core/capabilities/gmail/intent';
import { runTask } from '@/core/agent/task-manager';
import { nanoid } from 'nanoid';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

async function main() {
  // ---------- M: Calendar vs Tasks — unit-level, exactly one detector claims each phrase ----------
  const mCases: { text: string; expect: 'calendar' | 'tasks' }[] = [
    { text: 'Schedule a meeting tomorrow at 3', expect: 'calendar' },
    { text: 'Remind me to submit the report tomorrow', expect: 'tasks' },
    { text: 'What meetings do I have tomorrow?', expect: 'calendar' },
    { text: 'What do I need to do tomorrow?', expect: 'tasks' },
    { text: 'Am I free tomorrow at 3?', expect: 'calendar' },
  ];
  for (const c of mCases) {
    const cal = detectCalendarIntent(c.text) !== null;
    const tasks = detectTasksIntent(c.text) !== null;
    const claimedByExpected = c.expect === 'calendar' ? cal && !tasks : tasks && !cal;
    check(`M. "${c.text}" -> ${c.expect.toUpperCase()} only, not both/neither`, claimedByExpected, `calendar=${cal} tasks=${tasks}`);
  }

  // ---------- M (end-to-end): the same phrases actually route through runTask() to the right capability ----------
  {
    const r1 = await runTask({ goal: 'Schedule a meeting tomorrow at 3 PM for 30 minutes.', onEvent: () => {}, taskId: nanoid() });
    check('M-e2e. "Schedule a meeting..." -> capability=calendar', r1.capability?.selected === 'calendar', `capability=${r1.capability?.selected}`);

    const r2 = await runTask({ goal: 'Remind me to submit the report tomorrow.', onEvent: () => {}, taskId: nanoid() });
    check('M-e2e. "Remind me to submit..." -> capability=tasks', r2.capability?.selected === 'tasks', `capability=${r2.capability?.selected}`);

    const r3 = await runTask({ goal: 'What meetings do I have tomorrow?', onEvent: () => {}, taskId: nanoid() });
    check('M-e2e. "What meetings..." -> capability=calendar', r3.capability?.selected === 'calendar', `capability=${r3.capability?.selected}`);

    const r4 = await runTask({ goal: 'What do I need to do tomorrow?', onEvent: () => {}, taskId: nanoid() });
    check('M-e2e. "What do I need to do..." -> capability=tasks', r4.capability?.selected === 'tasks', `capability=${r4.capability?.selected}`);

    const r5 = await runTask({ goal: 'Am I free tomorrow at 3?', onEvent: () => {}, taskId: nanoid() });
    check('M-e2e. "Am I free..." -> capability=calendar', r5.capability?.selected === 'calendar', `capability=${r5.capability?.selected}`);
  }

  // ---------- N: Gmail body routing regression — draft bodies mentioning task/reminder/calendar phrasing stay GMAIL ----------
  const nCases = [
    'Draft an email to Alice saying remind me tomorrow',
    'Draft an email to Alice saying mark it complete',
    'Draft an email to Alice saying are you free today',
    'Draft an email to Bob saying I need to submit the report tomorrow',
  ];
  for (const text of nCases) {
    const gmail = detectGmailIntent(text) !== null;
    const cal = detectCalendarIntent(text) !== null;
    const tasks = detectTasksIntent(text) !== null;
    check(`N. "${text}" -> GMAIL only, never Calendar or Tasks`, gmail && !cal && !tasks, `gmail=${gmail} calendar=${cal} tasks=${tasks}`);
  }
  {
    const r = await runTask({ goal: 'Draft an email to Alice saying remind me tomorrow', onEvent: () => {}, taskId: nanoid() });
    check('N-e2e. Gmail draft body regression stays on the Gmail capability end-to-end', r.capability?.selected === 'gmail', `capability=${r.capability?.selected}`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
