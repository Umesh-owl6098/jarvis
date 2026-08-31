/**
 * Checkpoint 20 §16 — structural proof that voice uses the SAME Tasks path
 * as typed text: normalizeVoiceCommand() strips the wake word only, then
 * the normalized string goes through the exact same runTask() used
 * everywhere else. No voice-only Tasks branch exists to test separately.
 */
process.env.USE_MOCK_TASKS = 'true';

import { normalizeVoiceCommand } from '@/lib/voice/normalize';
import { runTask } from '@/core/agent/task-manager';
import { tasksPendingActionStore } from '@/core/capabilities/tasks/pending-action';
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

  const spoken = 'Jarvis, remind me to submit my report tomorrow.';
  const normalized = normalizeVoiceCommand(spoken);
  check(
    'wake word stripped, command text otherwise unchanged',
    normalized.submittable && normalized.command === 'remind me to submit my report tomorrow',
    `command="${normalized.command}"`
  );

  const r = await runTask({ sessionId: SID, goal: normalized.command, onEvent: () => {}, taskId: nanoid() });
  check(
    'normalized voice command produces a proposal only — no auto-create',
    r.status === 'success' && /TASK READY FOR CONFIRMATION/.test(r.result) && !!r.tasks?.pendingAction,
    `result=${r.result.slice(0, 150)}`
  );

  // A bare "create it" from voice still requires the same explicit
  // confirmation gate as typed text — no voice-only bypass.
  const confirmSpoken = normalizeVoiceCommand('Jarvis, create it.');
  const confirmResult = await runTask({ sessionId: SID, goal: confirmSpoken.command, onEvent: () => {}, taskId: nanoid() });
  check(
    'voice confirmation goes through the identical create-confirmation path',
    confirmResult.status === 'success' && /^Created /.test(confirmResult.result),
    `command="${confirmSpoken.command}" result=${confirmResult.result}`
  );

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
