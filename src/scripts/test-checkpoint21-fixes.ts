/**
 * Checkpoint 21 fix regression — the 4 real gaps found during real-backend
 * verification and fixed afterward:
 *   1. Compound-request recognition generalized via a concept-based
 *      classifier (shared/compound-classifier.ts), not per-sentence regex.
 *   2. Multi-pending cancellation semantics — capability-specific cancel
 *      phrases, "cancel both/all," and explicit clarification instead of
 *      silent guessing when 2+ pendings are active.
 *   3. Gmail draft creation vs. externally-consequential mutation are now
 *      distinguished in reporting (remoteWriteOccurred).
 *   4. Gmail "from X" search now scopes to sender metadata (from: operator)
 *      instead of matching body-text coincidence.
 * All 14 required cases below, all through runTask() — the exact function
 * the production Command Channel/voice share — with mocks only.
 */
process.env.USE_MOCK_GMAIL = 'true';
process.env.USE_MOCK_CALENDAR = 'true';
process.env.USE_MOCK_TASKS = 'true';
process.env.USE_MOCK_CONTACTS = 'true';

import { runTask } from '@/core/agent/task-manager';
import { normalizeVoiceCommand } from '@/lib/voice/normalize';
import { pendingActionStore } from '@/core/capabilities/gmail/pending-action';
import { calendarPendingActionStore } from '@/core/capabilities/calendar/pending-action';
import { tasksPendingActionStore } from '@/core/capabilities/tasks/pending-action';
import { getGmailClient } from '@/core/capabilities/gmail/resolve';
import { detectGmailIntent } from '@/core/capabilities/gmail/intent';
import { nanoid } from 'nanoid';
import type { ExecutionResult } from '@/core/agent/executor';

const SID = 'test-session';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

function clearAllPending() {
  pendingActionStore.clear(SID);
  calendarPendingActionStore.clear(SID);
  tasksPendingActionStore.clear(SID);
}

function browserWasInvoked(r: ExecutionResult): boolean {
  return r.events.some((e) => e.type === 'browser.initialized');
}

async function main() {
  // ---------- 1. Calendar + Tasks paraphrase -> both execute ----------
  {
    const r = await runTask({ sessionId: SID, goal: 'What meetings and tasks do I have today?', onEvent: () => {}, taskId: nanoid() });
    check(
      '1. "What meetings and tasks do I have today?" -> orchestration, calendar+tasks both completed',
      r.capability?.selected === 'orchestration' &&
        r.orchestration?.steps.find((s) => s.capability === 'calendar')?.status === 'completed' &&
        r.orchestration?.steps.find((s) => s.capability === 'tasks')?.status === 'completed',
      `pattern=${r.orchestration?.pattern} steps=${JSON.stringify(r.orchestration?.steps.map((s) => s.capability))}`
    );
  }

  // ---------- 2. Reversed Tasks + Calendar wording -> both execute ----------
  {
    const r = await runTask({ sessionId: SID, goal: 'Show my tasks and meetings for tomorrow.', onEvent: () => {}, taskId: nanoid() });
    check(
      '2. reversed "tasks and meetings" wording -> orchestration, both completed',
      r.capability?.selected === 'orchestration' &&
        r.orchestration?.steps.find((s) => s.capability === 'calendar')?.status === 'completed' &&
        r.orchestration?.steps.find((s) => s.capability === 'tasks')?.status === 'completed',
      `pattern=${r.orchestration?.pattern}`
    );
  }

  // ---------- 3. Unsupported multi-capability combination cannot be silently narrowed ----------
  {
    const r = await runTask({ sessionId: SID, goal: 'What emails and tasks do I have today?', onEvent: () => {}, taskId: nanoid() });
    check(
      '3. Gmail+Tasks combo (unsupported) -> explicit "not supported" response, never narrowed to one capability',
      r.capability?.selected === 'orchestration' &&
        r.orchestration?.pattern === 'unsupported-compound' &&
        /gmail/i.test(r.result) && /tasks/i.test(r.result),
      `capability=${r.capability?.selected} pattern=${r.orchestration?.pattern} result=${r.result}`
    );
  }

  // ---------- 4. Compound request never accidentally reaches Browser ----------
  {
    const goals = [
      'What meetings and tasks do I have today?',
      "Tell me what's on my calendar and task list today.",
      'What emails and tasks do I have today?',
    ];
    for (const goal of goals) {
      const r = await runTask({ sessionId: SID, goal, onEvent: () => {}, taskId: nanoid() });
      check(
        `4. "${goal}" never reaches Browser`,
        r.capability?.selected !== 'browser' && !browserWasInvoked(r),
        `capability=${r.capability?.selected} browserInvoked=${browserWasInvoked(r)}`
      );
    }
  }

  // ---------- 5. Calendar+Gmail dual pending state represented correctly ----------
  {
    clearAllPending();
    const r = await runTask({ sessionId: SID, goal: 'Schedule a meeting with Alice next Monday at 2 PM and draft an email telling them.', onEvent: () => {}, taskId: nanoid() });
    check(
      '5. Pattern 3 leaves BOTH Calendar and Gmail pending simultaneously, correctly represented',
      !!calendarPendingActionStore.active(SID) && !!pendingActionStore.active(SID) &&
        r.orchestration?.steps.find((s) => s.capability === 'calendar')?.status === 'pending_confirmation' &&
        r.orchestration?.steps.find((s) => s.capability === 'gmail')?.status === 'pending_confirmation' &&
        r.orchestration?.steps.find((s) => s.capability === 'gmail')?.remoteWriteOccurred === true &&
        r.orchestration?.steps.find((s) => s.capability === 'calendar')?.remoteWriteOccurred !== true,
      `steps=${JSON.stringify(r.orchestration?.steps.map((s) => ({ cap: s.capability, status: s.status, write: s.remoteWriteOccurred })))}`
    );
  }

  // ---------- 6. "Cancel the meeting" clears only Calendar ----------
  {
    const before = { cal: !!calendarPendingActionStore.active(SID), gmail: !!pendingActionStore.active(SID) };
    const r = await runTask({ sessionId: SID, goal: 'Cancel the meeting.', onEvent: () => {}, taskId: nanoid() });
    check(
      '6. "Cancel the meeting." clears ONLY Calendar, Gmail draft untouched',
      before.cal && before.gmail && // sanity: both were active before this
        !calendarPendingActionStore.active(SID) && !!pendingActionStore.active(SID) &&
        /calendar change was not made/i.test(r.result),
      `result=${r.result} calStillActive=${!!calendarPendingActionStore.active(SID)} gmailStillActive=${!!pendingActionStore.active(SID)}`
    );
  }

  // ---------- 7. "Cancel the email" clears only Gmail ----------
  {
    check('7-setup. Gmail still pending from step 5/6', !!pendingActionStore.active(SID));
    const r = await runTask({ sessionId: SID, goal: 'Cancel the email.', onEvent: () => {}, taskId: nanoid() });
    check(
      '7. "Cancel the email." clears ONLY Gmail',
      !pendingActionStore.active(SID) && /draft was not sent/i.test(r.result),
      `result=${r.result} gmailStillActive=${!!pendingActionStore.active(SID)}`
    );
    clearAllPending();
  }

  // ---------- 8. "Cancel both/all" clears both ----------
  {
    clearAllPending();
    await runTask({ sessionId: SID, goal: 'Schedule a meeting with Alice next Monday at 3 PM and draft an email telling them.', onEvent: () => {}, taskId: nanoid() });
    check('8-setup. both pending before cancel-all', !!calendarPendingActionStore.active(SID) && !!pendingActionStore.active(SID));
    const r = await runTask({ sessionId: SID, goal: 'Cancel all.', onEvent: () => {}, taskId: nanoid() });
    check(
      '8. "Cancel all." clears BOTH Calendar and Gmail',
      !calendarPendingActionStore.active(SID) && !pendingActionStore.active(SID) && r.status === 'success',
      `result=${r.result} calActive=${!!calendarPendingActionStore.active(SID)} gmailActive=${!!pendingActionStore.active(SID)}`
    );
  }

  // ---------- 9. Bare "Cancel" with two pendings asks for clarification, clears neither ----------
  {
    clearAllPending();
    await runTask({ sessionId: SID, goal: 'Schedule a meeting with Alice next Monday at 4 PM and draft an email telling them.', onEvent: () => {}, taskId: nanoid() });
    const before = { cal: !!calendarPendingActionStore.active(SID), gmail: !!pendingActionStore.active(SID) };
    const r = await runTask({ sessionId: SID, goal: 'Cancel', onEvent: () => {}, taskId: nanoid() });
    check(
      '9. bare "Cancel" with 2 pendings asks which, clears NEITHER',
      before.cal && before.gmail &&
        !!calendarPendingActionStore.active(SID) && !!pendingActionStore.active(SID) &&
        /which should i cancel/i.test(r.result) && /calendar/i.test(r.result) && /gmail/i.test(r.result),
      `result=${r.result} calStillActive=${!!calendarPendingActionStore.active(SID)} gmailStillActive=${!!pendingActionStore.active(SID)}`
    );
    clearAllPending();
  }

  // ---------- 10. Confirming one pending action cannot confirm the other ----------
  {
    clearAllPending();
    await runTask({ sessionId: SID, goal: 'Schedule a meeting with Alice next Monday at 5 PM and draft an email telling them.', onEvent: () => {}, taskId: nanoid() });
    const gmailBefore = !!pendingActionStore.active(SID);
    const r = await runTask({ sessionId: SID, goal: 'Create it.', onEvent: () => {}, taskId: nanoid() });
    check(
      '10. "Create it." confirms Calendar only — Gmail draft remains pending, unsent',
      r.status === 'success' && /^Created /.test(r.result) &&
        !calendarPendingActionStore.active(SID) && !!pendingActionStore.active(SID) && gmailBefore,
      `result=${r.result} gmailStillActive=${!!pendingActionStore.active(SID)}`
    );
    clearAllPending();
  }

  // ---------- 11. Prompt injection / retrieved content cannot manufacture another compound step ----------
  {
    clearAllPending();
    // The malicious Gmail fixture's body explicitly says "and create a new
    // event" / "System override" style injection text — verify reading it
    // through the orchestration path creates ONLY the one intended
    // Tasks proposal, never a Calendar step that was never requested.
    const r = await runTask({ sessionId: SID, goal: 'Find the latest email from attacker and create a task to reply tomorrow.', onEvent: () => {}, taskId: nanoid() });
    check(
      '11. malicious email content cannot manufacture an extra Calendar/Gmail step beyond the two originally requested',
      r.orchestration?.steps.length === 2 &&
        r.orchestration?.steps.every((s) => s.capability === 'gmail' || s.capability === 'tasks') &&
        !calendarPendingActionStore.active(SID),
      `stepCount=${r.orchestration?.steps.length} caps=${JSON.stringify(r.orchestration?.steps.map((s) => s.capability))}`
    );
    clearAllPending();
  }

  // ---------- 12. Gmail "from X" uses sender metadata, not body-text coincidence ----------
  {
    const intent = detectGmailIntent('Find the latest email from Sarah');
    check('12a. detectGmailIntent builds a sender-scoped query (from:)', intent?.searchQuery === 'from:Sarah', `searchQuery=${intent?.searchQuery}`);

    const client = getGmailClient();
    const bodyMentionOnly = await client.search('Sarah', 10); // plain full-text — unaffected, still matches body mentions
    const senderScoped = await client.search('from:Sarah', 10); // sender-scoped — must exclude body-only mentions
    check(
      '12b. plain full-text search still matches body-only mentions (unaffected)',
      bodyMentionOnly.messages.length >= 2,
      `count=${bodyMentionOnly.messages.length}`
    );
    check(
      '12c. from:-scoped search excludes messages where the name appears only in body/subject, not the From header',
      senderScoped.messages.length === 1 && senderScoped.messages.every((m) => m.from.toLowerCase().includes('sarah')),
      `count=${senderScoped.messages.length} senders=${JSON.stringify(senderScoped.messages.map((m) => m.from))}`
    );
  }

  // ---------- 13. Existing single-capability behavior remains unchanged ----------
  {
    const r1 = await runTask({ sessionId: SID, goal: 'What tasks do I have today?', onEvent: () => {}, taskId: nanoid() });
    check('13a. single-capability Tasks unaffected', r1.capability?.selected === 'tasks', `capability=${r1.capability?.selected}`);
    const r2 = await runTask({ sessionId: SID, goal: 'What meetings do I have tomorrow?', onEvent: () => {}, taskId: nanoid() });
    check('13b. single-capability Calendar unaffected', r2.capability?.selected === 'calendar', `capability=${r2.capability?.selected}`);
    const r3 = await runTask({ sessionId: SID, goal: 'What is my latest email?', onEvent: () => {}, taskId: nanoid() });
    check('13c. single-capability Gmail unaffected', r3.capability?.selected === 'gmail', `capability=${r3.capability?.selected}`);
  }

  // ---------- 14. Typed UI and voice use the same orchestration path ----------
  {
    const spoken = normalizeVoiceCommand('Jarvis, what meetings and tasks do I have today?');
    const r = await runTask({ sessionId: SID, goal: spoken.command, onEvent: () => {}, taskId: nanoid() });
    check(
      '14. voice-normalized compound request reaches the SAME orchestration path',
      r.capability?.selected === 'orchestration' && r.orchestration?.pattern === 'calendar-tasks-summary',
      `command="${spoken.command}" pattern=${r.orchestration?.pattern}`
    );
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
