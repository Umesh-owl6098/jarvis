/**
 * Checkpoint 28 §Intent/routing — recognizes the personal-attention
 * grammar (imperative AND interrogative shapes), rejects generic
 * informational questions, never reaches browser/OmniRoute for a
 * supported query, rejects compound mutation tails, and preserves CP27's
 * own existing routing for the two phrases it shares vocabulary with.
 */
const TEST_PREFS_PATH = require('os').tmpdir() + '/jarvis-cp28-parsing-' + Date.now() + '.json';
process.env.JARVIS_PREFERENCES_PATH = TEST_PREFS_PATH;

process.env.USE_MOCK_GMAIL = 'true';
process.env.USE_MOCK_CALENDAR = 'true';
process.env.USE_MOCK_TASKS = 'true';
process.env.USE_MOCK_CONTACTS = 'true';

import { runTask } from '@/core/agent/task-manager';
import { detectAttentionIntent } from '@/core/agent/attention/intent';
import { tasksPendingActionStore } from '@/core/capabilities/tasks/pending-action';
import type { ExecutionResult } from '@/core/agent/executor';
import { nanoid } from 'nanoid';

const SID = 'test-session-a';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

function browserWasInvoked(r: ExecutionResult): boolean {
  return r.events.some((e) => e.type === 'browser.initialized');
}

async function main() {
  // ---------- 1-10. required positives ----------
  const positives: [string, string][] = [
    ['1', 'Anything urgent?'],
    ['2', 'Is anything urgent?'],
    ['3', 'Anything I should know about?'],
    ['4', 'Is there anything I should know about?'],
    ['5', 'What should I watch today?'],
    ['6', 'What needs my attention right now?'],
    ['7', 'Anything coming up soon?'],
    ['8', 'Do I have anything coming up soon?'],
    ['9', "What's coming up soon?"],
    ['10', 'Is there anything important today?'],
  ];
  for (const [n, phrase] of positives) {
    const r = await runTask({ sessionId: SID, goal: phrase, onEvent: () => {}, taskId: nanoid() });
    check(`${n}. "${phrase}" recognized as an attention check`, r.capability?.selected === 'attention' && r.outcome === 'completed', `capability=${r.capability?.selected} outcome=${r.outcome}`);
  }

  // ---------- variant scope words (today/tomorrow/this morning/this afternoon/this evening/right now/soon) ----------
  const variants: [string, string][] = [
    ['11', 'Anything urgent this morning?'],
    ['12', 'Anything urgent this afternoon?'],
    ['13', 'Anything urgent this evening?'],
    ['14', 'Anything I should know about tomorrow?'],
  ];
  for (const [n, phrase] of variants) {
    const r = detectAttentionIntent(phrase);
    check(`${n}. "${phrase}" recognized with its own scope word`, r !== null, `result=${JSON.stringify(r)}`);
  }

  // ---------- generic negatives (classifier-level — see CP27's own precedent for why: none of these match any other capability, so a full runTask() would fall through to the slow real browser/OmniRoute path) ----------
  const negatives: [string, string][] = [
    ['neg-a', 'What is urgency?'],
    ['neg-b', 'What is attention?'],
    ['neg-c', 'What is important in machine learning?'],
    ['neg-d', "What's coming up in technology?"],
    ['neg-e', 'What should investors watch today?'],
    ['neg-f', "What's important in the news today?"],
  ];
  for (const [n, phrase] of negatives) {
    const result = detectAttentionIntent(phrase);
    check(`${n}. "${phrase}" NOT recognized as an attention check`, result === null, `result=${JSON.stringify(result)}`);
  }

  // ---------- CP27 boundary: shared-vocabulary phrases stay with CP27, unchanged ----------
  {
    const r = await runTask({ sessionId: SID, goal: 'What should I handle first?', onEvent: () => {}, taskId: nanoid() });
    check('cp27-a. "What should I handle first?" still routes to CP27 briefing (deliberately not claimed by CP28)', r.capability?.selected === 'briefing', `capability=${r.capability?.selected}`);
  }
  {
    const r = await runTask({ sessionId: SID, goal: 'What needs my attention today?', onEvent: () => {}, taskId: nanoid() });
    check('cp27-b. "What needs my attention today?" (day-scoped) still routes to CP27 briefing, unchanged', r.capability?.selected === 'briefing', `capability=${r.capability?.selected}`);
  }
  {
    const r = await runTask({ sessionId: SID, goal: "What's coming up tomorrow?", onEvent: () => {}, taskId: nanoid() });
    check('cp27-c. "What\'s coming up tomorrow?" (day-scoped) still routes to CP27 briefing, unchanged', r.capability?.selected === 'briefing', `capability=${r.capability?.selected}`);
  }
  {
    const r = await runTask({ sessionId: SID, goal: 'What needs my attention right now?', onEvent: () => {}, taskId: nanoid() });
    check('cp27-d. "What needs my attention right now?" (right-now-scoped) routes to CP28 attention, not CP27', r.capability?.selected === 'attention', `capability=${r.capability?.selected}`);
  }

  // ---------- direct capability routing / no browser fallback ----------
  {
    const r = await runTask({ sessionId: SID, goal: 'Anything urgent?', onEvent: () => {}, taskId: nanoid() });
    check('routing-a. "Anything urgent?" never opens the browser', !browserWasInvoked(r), `capability=${r.capability?.selected}`);
  }
  {
    const r = await runTask({ sessionId: SID, goal: 'Anything coming up soon?', onEvent: () => {}, taskId: nanoid() });
    check('routing-b. "Anything coming up soon?" never reaches OmniRoute planning', !browserWasInvoked(r), `capability=${r.capability?.selected}`);
  }
  {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 150);
    const r = await runTask({ sessionId: SID, goal: 'What should investors watch today?', onEvent: () => {}, taskId: nanoid(), signal: controller.signal });
    check(
      'routing-c. the genuine generic negative is NOT stolen — real routing reaches the browser path',
      r.capability?.selected !== 'attention' && browserWasInvoked(r),
      `capability=${r.capability?.selected} browserInvoked=${browserWasInvoked(r)}`
    );
  }

  // ---------- compound-tail rejection ----------
  {
    const before = tasksPendingActionStore.active(SID);
    const r = await runTask({ sessionId: SID, goal: 'Anything urgent and create a task to prepare.', onEvent: () => {}, taskId: nanoid() });
    check(
      'compound-a. "Anything urgent and create a task..." is reported as unsupported, not silently narrowed',
      r.capability?.selected === 'attention' && r.outcome === 'blocked' && /create a task/i.test(r.result),
      `capability=${r.capability?.selected} outcome=${r.outcome} result=${r.result}`
    );
    check('compound-a2. no real Task was silently created', tasksPendingActionStore.active(SID) === before);
  }
  {
    const r = await runTask({ sessionId: SID, goal: 'What needs my attention and email GV.', onEvent: () => {}, taskId: nanoid() });
    check(
      'compound-b. "What needs my attention and email GV." — either unsupported-compound or falls to CP27 unchanged, never silently executes the email half',
      r.outcome !== 'completed' || r.capability?.selected === 'briefing',
      `capability=${r.capability?.selected} outcome=${r.outcome} result=${r.result.slice(0, 150)}`
    );
  }
  {
    const r = await runTask({ sessionId: SID, goal: "Tell me what's coming up soon then cancel my meeting.", onEvent: () => {}, taskId: nanoid() });
    check(
      'compound-c. "...coming up soon then cancel my meeting." is reported as unsupported, not silently narrowed',
      r.capability?.selected === 'attention' && r.outcome === 'blocked' && /cancel/i.test(r.result),
      `capability=${r.capability?.selected} outcome=${r.outcome} result=${r.result}`
    );
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  try { require('fs').rmSync(TEST_PREFS_PATH, { force: true }); } catch {}
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error('Fatal error:', e);
  try { require('fs').rmSync(TEST_PREFS_PATH, { force: true }); } catch {}
  process.exit(1);
});
