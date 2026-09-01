/**
 * Checkpoint 25 §Gmail — conversational draft revision (Priority 3).
 * Reuses the existing CP22 updateDraft mechanism — same draft ID, never a
 * second draft, never sends. Body revision only (recipient revision is
 * explicitly deferred — see proposal-revision.ts's module comment).
 */
const TEST_PREFS_PATH = require('os').tmpdir() + '/jarvis-cp25-gmail-revision-' + Date.now() + '.json';
process.env.JARVIS_PREFERENCES_PATH = TEST_PREFS_PATH;

process.env.USE_MOCK_GMAIL = 'true';
process.env.USE_MOCK_CALENDAR = 'true';
process.env.USE_MOCK_TASKS = 'true';
process.env.USE_MOCK_CONTACTS = 'true';

import { runTask } from '@/core/agent/task-manager';
import { pendingActionStore } from '@/core/capabilities/gmail/pending-action';
import { calendarPendingActionStore } from '@/core/capabilities/calendar/pending-action';
import { tasksPendingActionStore } from '@/core/capabilities/tasks/pending-action';
import { pendingSlotStore } from '@/core/agent/pending-slot';
import { getGmailClient } from '@/core/capabilities/gmail/resolve';
import { nanoid } from 'nanoid';

const SID = 'test-session-a';
const SID_B = 'test-session-b';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

function clearAllPending(sid: string) {
  pendingActionStore.clear(sid);
  calendarPendingActionStore.clear(sid);
  tasksPendingActionStore.clear(sid);
  pendingSlotStore.clear(sid);
}

async function main() {
  clearAllPending(SID);
  clearAllPending(SID_B);

  // ---------- 19. body revision ----------
  {
    clearAllPending(SID);
    await runTask({ sessionId: SID, goal: "Draft an email to Alice saying I'll be there at 4.", onEvent: () => {}, taskId: nanoid() });
    const draftId = pendingActionStore.active(SID)!.draftId;
    const r = await runTask({ sessionId: SID, goal: "Change it to say I'll be there at 4:30.", onEvent: () => {}, taskId: nanoid() });
    check(
      "19. body revision — \"Change it to say I'll be there at 4:30.\" replaces the body",
      /DRAFT UPDATED/.test(r.result) && /4:30/.test(r.result) && !/I'll be there at 4\./.test(r.result),
      `result=${r.result}`
    );
    check('19b. same draft ID after revision', pendingActionStore.active(SID)!.draftId === draftId);
    clearAllPending(SID);
  }

  // ---------- 20. a CP24-created draft (via the missing-body slot) can subsequently be revised ----------
  {
    clearAllPending(SID);
    const clarify = await runTask({ sessionId: SID, goal: 'email Alice', onEvent: () => {}, taskId: nanoid() });
    check('20-setup. CP24 clarification fired', clarify.result === 'What would you like the email to say?');
    const drafted = await runTask({ sessionId: SID, goal: "Tell her I'll be there at 4.", onEvent: () => {}, taskId: nanoid() });
    check('20-setup2. CP24 slot completion created a real draft', /DRAFT CREATED/.test(drafted.result));
    const draftId = pendingActionStore.active(SID)!.draftId;
    const r = await runTask({ sessionId: SID, goal: "Actually say I'll be there at 4:30.", onEvent: () => {}, taskId: nanoid() });
    check(
      '20. a CP24-created draft can subsequently be revised via CP25\'s "actually say X"',
      /DRAFT UPDATED/.test(r.result) && /4:30/.test(r.result),
      `result=${r.result}`
    );
    check('20b. same draft ID preserved from the CP24-created draft', pendingActionStore.active(SID)!.draftId === draftId);
    clearAllPending(SID);
  }

  // ---------- 21. same draft ID preserved / 22. no second draft created ----------
  {
    clearAllPending(SID);
    await runTask({ sessionId: SID, goal: "Draft an email to Alice saying original body.", onEvent: () => {}, taskId: nanoid() });
    const firstDraftId = pendingActionStore.active(SID)!.draftId;
    const client = getGmailClient();
    await runTask({ sessionId: SID, goal: "Change it to say revised body one.", onEvent: () => {}, taskId: nanoid() });
    await runTask({ sessionId: SID, goal: "Change it to say revised body two.", onEvent: () => {}, taskId: nanoid() });
    const secondDraftId = pendingActionStore.active(SID)!.draftId;
    check('21. same draft ID preserved across multiple revisions', firstDraftId === secondDraftId, `first=${firstDraftId} second=${secondDraftId}`);
    const finalDraft = client.getDraft(firstDraftId);
    check('22. no second draft created — the ORIGINAL draft object itself was updated in place', finalDraft?.body === 'revised body two', `body=${finalDraft?.body}`);
    clearAllPending(SID);
  }

  // ---------- 23. recipient preserved ----------
  {
    clearAllPending(SID);
    await runTask({ sessionId: SID, goal: "Draft an email to Alice saying hello.", onEvent: () => {}, taskId: nanoid() });
    const before = pendingActionStore.active(SID)!.recipient;
    const r = await runTask({ sessionId: SID, goal: "Change it to say a different message.", onEvent: () => {}, taskId: nanoid() });
    const after = pendingActionStore.active(SID)!.recipient;
    check('23. recipient preserved by a body-only revision (never re-resolved, never changed)', JSON.stringify(before) === JSON.stringify(after) && before.includes('alice@example.com'), `before=${before} after=${after} result=${r.result}`);
    clearAllPending(SID);
  }

  // ---------- 24. revision never sends / 25. send confirmation still required ----------
  {
    clearAllPending(SID);
    await runTask({ sessionId: SID, goal: "Draft an email to Alice saying hello.", onEvent: () => {}, taskId: nanoid() });
    const draftId = pendingActionStore.active(SID)!.draftId;
    const client = getGmailClient();
    const r = await runTask({ sessionId: SID, goal: "Change it to say goodbye instead.", onEvent: () => {}, taskId: nanoid() });
    const draftAfterRevision = client.getDraft(draftId);
    check('24. revision never sends — the draft object itself remains unsent', draftAfterRevision?.sent === false, `sent=${draftAfterRevision?.sent} result=${r.result}`);
    check('24b. revision result explicitly says "not sent"', /not sent/i.test(r.result));

    // Sending still requires the EXISTING, unmodified confirmation gate.
    const sent = await runTask({ sessionId: SID, goal: 'Send it.', onEvent: () => {}, taskId: nanoid() });
    check('25. "Send it." after revision still goes through the existing send confirmation gate and actually sends', /^Sent email to/.test(sent.result) && !!sent.gmail?.sentMessageId, `result=${sent.result}`);
    const draftAfterSend = client.getDraft(draftId);
    check('25b. exactly the revised (goodbye) body was what got sent', draftAfterSend?.body === 'goodbye instead', `body=${draftAfterSend?.body}`);
    clearAllPending(SID);
  }

  // ---------- 26. cross-session revision blocked ----------
  {
    clearAllPending(SID);
    clearAllPending(SID_B);
    await runTask({ sessionId: SID, goal: "Draft an email to Alice saying hello.", onEvent: () => {}, taskId: nanoid() });
    const draftId = pendingActionStore.active(SID)!.draftId;
    const client = getGmailClient();
    const before = client.getDraft(draftId)?.body;
    const r = await runTask({ sessionId: SID_B, goal: "Change it to say hijacked.", onEvent: () => {}, taskId: nanoid() });
    const after = client.getDraft(draftId)?.body;
    check('26. Session B\'s revision attempt does not touch Session A\'s pending draft', before === after, `before=${before} after=${after} result=${r.result}`);
    check('26b. Session B has nothing pending of its own', !pendingActionStore.active(SID_B));
    clearAllPending(SID);
    clearAllPending(SID_B);
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
