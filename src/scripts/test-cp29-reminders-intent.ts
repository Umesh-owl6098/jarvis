/**
 * Checkpoint 29 §Intent — deterministic reminder create/list/next/cancel
 * grammar: required positive paraphrases, generic negatives that must
 * never be stolen, and the Tasks-collision boundary (CP20's own "remind
 * me to X" and "reminder" concept-word vocabulary).
 */
import { detectReminderIntent } from '@/core/reminders/intent';
import { detectTasksIntent } from '@/core/capabilities/tasks/intent';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

async function main() {
  // ---------- create paraphrases ----------
  const createCases: [string, string, string][] = [
    ['1', 'Remind me at 4 PM to call GV.', 'call GV'],
    ['2', 'Remind me tomorrow at 9 to submit the report.', 'submit the report'],
    ['3', 'Remind me tomorrow morning to submit the report.', 'submit the report'],
    ['4', 'Remind me in 20 minutes to check the oven.', 'check the oven'],
    ['5', 'Remind me in 2 hours to take a break.', 'take a break'],
    ['6', 'Set a reminder for Friday at 3 PM to review the document.', 'review the document'],
  ];
  for (const [n, phrase, expectedText] of createCases) {
    const intent = detectReminderIntent(phrase);
    check(`${n}. "${phrase}" recognized as create`, intent?.operation === 'create', `intent=${JSON.stringify(intent)}`);
    check(`${n}b. "${phrase}" extracts the correct reminder text`, intent?.text === expectedText, `text=${intent?.text}`);
    check(`${n}c. "${phrase}" extracts a non-empty time phrase`, !!intent?.timePhrase, `timePhrase=${intent?.timePhrase}`);
  }

  // ---------- list ----------
  const listCases: [string, string][] = [
    ['7', 'What reminders do I have?'],
    ['8', 'Show my reminders.'],
    ['9', 'Show me my reminders.'],
    ['10', 'List my reminders.'],
  ];
  for (const [n, phrase] of listCases) {
    const intent = detectReminderIntent(phrase);
    check(`${n}. "${phrase}" recognized as list`, intent?.operation === 'list', `intent=${JSON.stringify(intent)}`);
  }

  // ---------- next ----------
  const nextCases: [string, string][] = [
    ["11", "What's my next reminder?"],
    ['12', 'What is my next reminder?'],
    ["13", "When's my next reminder?"],
  ];
  for (const [n, phrase] of nextCases) {
    const intent = detectReminderIntent(phrase);
    check(`${n}. "${phrase}" recognized as next`, intent?.operation === 'next', `intent=${JSON.stringify(intent)}`);
  }

  // ---------- cancel ----------
  const cancelCases: [string, string, string][] = [
    ['14', 'Cancel my reminder to check the oven.', 'check the oven'],
    ['15', 'Delete the reminder about the report.', 'the report'],
    ['16', 'Cancel reminder for the meeting prep.', 'the meeting prep'],
  ];
  for (const [n, phrase, expectedQuery] of cancelCases) {
    const intent = detectReminderIntent(phrase);
    check(`${n}. "${phrase}" recognized as cancel`, intent?.operation === 'cancel', `intent=${JSON.stringify(intent)}`);
    check(`${n}b. "${phrase}" extracts the search query`, intent?.searchQuery === expectedQuery, `searchQuery=${intent?.searchQuery}`);
  }

  // ---------- generic negatives — must NOT be stolen ----------
  const negatives: [string, string][] = [
    ['neg-a', 'What is a reminder?'],
    ['neg-b', 'How do reminders work?'],
    ['neg-c', 'Remind me why the sky is blue.'],
    ['neg-d', 'What is reminder marketing?'],
    ['neg-e', 'Reminder marketing is a growing industry.'],
  ];
  for (const [n, phrase] of negatives) {
    const intent = detectReminderIntent(phrase);
    check(`${n}. "${phrase}" NOT recognized as a reminder request`, intent === null, `intent=${JSON.stringify(intent)}`);
  }

  // ---------- unsupported vague time — still recognized as create (time
  // resolution itself happens later, in datetime.ts/runner.ts) ----------
  {
    const intent = detectReminderIntent('Remind me sometime to water the plants.');
    check('vague-1. "Remind me sometime to X" is still grammatically a create (vague-time REJECTION happens downstream, not at the grammar level)', intent?.operation === 'create' && intent.timePhrase === 'sometime');
  }

  // ---------- incomplete command — deferred per §14, never claimed ----------
  {
    const intent = detectReminderIntent('Remind me tomorrow.');
    check('incomplete-1. "Remind me tomorrow." (no reminder text) is NOT claimed — falls through to normal routing (§14 deferred-slot decision)', intent === null, `intent=${JSON.stringify(intent)}`);
  }

  // ---------- Tasks collision boundary — the load-bearing disjointness ----------
  {
    const bareText = 'Remind me to check the oven.';
    const reminderIntent = detectReminderIntent(bareText);
    const tasksIntent = detectTasksIntent(bareText);
    check('collision-1. bare "Remind me to X" (no time) is NOT claimed by reminders/intent.ts', reminderIntent === null, `reminderIntent=${JSON.stringify(reminderIntent)}`);
    check('collision-1b. bare "Remind me to X" (no time) IS still claimed by Tasks, unaffected by CP29', tasksIntent !== null && tasksIntent.operation === 'propose_create', `tasksIntent=${JSON.stringify(tasksIntent)}`);
  }
  {
    const timedText = 'Remind me at 4 PM to check the oven.';
    const reminderIntent = detectReminderIntent(timedText);
    const tasksIntent = detectTasksIntent(timedText);
    check('collision-2. "Remind me at 4 PM to X" (has a time) IS claimed by reminders/intent.ts', reminderIntent?.operation === 'create');
    check('collision-2b. "Remind me at 4 PM to X" is NOT ALSO claimed by Tasks (structurally disjoint — Tasks\' CREATE_REMIND_RE requires the literal contiguous "remind me to", never matching with a time phrase in between)', tasksIntent === null, `tasksIntent=${JSON.stringify(tasksIntent)}`);
  }
  {
    // Tasks' generic concept-word fallback would otherwise also match
    // "What reminders do I have?" (TASKS_CONCEPT_RE includes "reminders")
    // — confirming CP29 wins this specific phrase structurally, at the
    // grammar level (task-manager.ts's own dispatch ORDER is what makes
    // this actually win at runtime — see the regression test file).
    const text = 'What reminders do I have?';
    const reminderIntent = detectReminderIntent(text);
    check('collision-3. "What reminders do I have?" IS recognized by reminders/intent.ts (wins the concept-word collision at the grammar level)', reminderIntent?.operation === 'list');
  }
  {
    // A genuine Tasks query using "task" (not "reminder") must remain
    // completely untouched by CP29's own grammar.
    const text = 'What tasks do I have?';
    const reminderIntent = detectReminderIntent(text);
    check('collision-4. "What tasks do I have?" is NOT touched by reminders/intent.ts', reminderIntent === null);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
