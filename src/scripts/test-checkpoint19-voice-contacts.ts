/**
 * Checkpoint 19 §13/19 — structural proof that voice uses the SAME
 * resolution path as typed text: normalizeVoiceCommand() strips the wake
 * word only, then the normalized string is handed to the exact same
 * runTask() used everywhere else. There is no voice-only Contacts branch to
 * test separately — this test demonstrates that fact rather than
 * special-casing around it.
 */
process.env.USE_MOCK_GMAIL = 'true';
process.env.USE_MOCK_CONTACTS = 'true';

import { normalizeVoiceCommand } from '@/lib/voice/normalize';
import { runTask } from '@/core/agent/task-manager';
import { pendingActionStore } from '@/core/capabilities/gmail/pending-action';
import { nanoid } from 'nanoid';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

async function main() {
  pendingActionStore.clear();

  const spoken = 'Jarvis, draft an email to Alice saying call me later.';
  const normalized = normalizeVoiceCommand(spoken);
  check(
    'wake word stripped, command text otherwise unchanged',
    normalized.submittable && normalized.command === 'draft an email to Alice saying call me later',
    `command="${normalized.command}"`
  );

  const r = await runTask({ goal: normalized.command, onEvent: () => {}, taskId: nanoid() });
  check(
    'normalized voice command resolves Alice via Contacts and creates a draft — no auto-send',
    r.status === 'success' && /DRAFT CREATED/.test(r.result) && /alice@example\.com/.test(r.result) && r.resolution?.status === 'resolved' && !!r.gmail?.pendingAction,
    `result=${r.result.slice(0, 200)} resolution=${JSON.stringify(r.resolution)}`
  );

  // A bare "yes"/"send it" from voice still requires the same explicit
  // confirmation gate as typed text — no voice-only bypass.
  const confirmSpoken = normalizeVoiceCommand('Jarvis, send it.');
  const confirmResult = await runTask({ goal: confirmSpoken.command, onEvent: () => {}, taskId: nanoid() });
  check(
    'voice confirmation goes through the identical send-confirmation path, still requires the exact phrase',
    confirmResult.status === 'success' && /^Sent email to alice@example\.com/.test(confirmResult.result),
    `command="${confirmSpoken.command}" result=${confirmResult.result}`
  );

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
