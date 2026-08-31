/**
 * Post-Checkpoint-20 production-path regression — proves the SAME entry
 * point the real Command Channel and voice both use (runTask() from
 * task-manager.ts, the exact function src/app/api/agent/stream/route.ts
 * calls when resolveRouterMode() === 'omniroute', which is the normal
 * `npm run dev` state with no mock-router flag set) correctly routes
 * direct-capability commands WITHOUT ever invoking the browser.
 *
 * Root cause this regression guards against: detectGmailIntent() and
 * detectCalendarIntent() only recognized IMPERATIVE phrasings ("Show my
 * latest emails", "What meetings do I have tomorrow") — real interrogative
 * phrasing a user actually typed through localhost:3000 ("What is the
 * latest email I got from Sarah?", "Do I have anything on my calendar
 * today?", "What emails did I get today?") returned null from BOTH
 * detectors, so runTask() correctly (per its own existing fallback design)
 * fell through to the generic browser/OmniRoute path — which then failed
 * trying to browse to a website for something that was never a browsing
 * task. This was a regex COVERAGE gap, not a routing/architecture bug —
 * the single authoritative path (frontend -> /api/agent/stream ->
 * runTask() -> capability router) was already correct and is unchanged
 * here; only the trigger vocabulary was extended.
 *
 * "browser controller never invoked" is verified by asserting NO
 * 'browser.initialized' event appears anywhere in the returned events —
 * the one event executor.ts emits the instant BrowserController.initialize()
 * actually runs (executor.ts:266), the most direct available signal that
 * Playwright/the browser subsystem was never started for these tasks.
 */
process.env.USE_MOCK_GMAIL = 'true';
process.env.USE_MOCK_CALENDAR = 'true';
process.env.USE_MOCK_TASKS = 'true';
process.env.USE_MOCK_CONTACTS = 'true';

import { runTask } from '@/core/agent/task-manager';
import { normalizeVoiceCommand } from '@/lib/voice/normalize';
import { resolveRouterMode, ROUTER_MODE_LABEL } from '@/core/router/mode';
import { pendingActionStore } from '@/core/capabilities/gmail/pending-action';
import { calendarPendingActionStore } from '@/core/capabilities/calendar/pending-action';
import { tasksPendingActionStore } from '@/core/capabilities/tasks/pending-action';
import { nanoid } from 'nanoid';
import type { ExecutionResult } from '@/core/agent/executor';

const SID = 'test-session';

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
  // ---------- 0: confirm this session's own router mode is the SAME production mode the route uses to decide whether to call runTask() at all ----------
  check(
    '0. resolveRouterMode() is OMNIROUTE (the mode under which the route calls runTask() at all, not the raw-AgentExecutor mock bypass)',
    resolveRouterMode() === 'omniroute',
    `mode=${ROUTER_MODE_LABEL[resolveRouterMode()]}`
  );

  // ---------- 1: UI-path Gmail commands — capability=gmail, browser never invoked ----------
  {
    const phrases = [
      'What is the latest email I got from Sarah?',
      'What is my latest email?',
      'What emails did I get today?',
    ];
    for (const goal of phrases) {
      const r = await runTask({ sessionId: SID, goal, onEvent: () => {}, taskId: nanoid() });
      check(
        `1. "${goal}" -> capability=gmail, browser controller never invoked`,
        r.capability?.selected === 'gmail' && !browserWasInvoked(r),
        `capability=${r.capability?.selected} browserInvoked=${browserWasInvoked(r)} result=${r.result.slice(0, 120)}`
      );
    }
  }

  // ---------- 2: UI-path Calendar commands — capability=calendar, browser never invoked ----------
  {
    const phrases = [
      'Do I have anything on my calendar today?',
      'What meetings do I have tomorrow?',
    ];
    for (const goal of phrases) {
      const r = await runTask({ sessionId: SID, goal, onEvent: () => {}, taskId: nanoid() });
      check(
        `2. "${goal}" -> capability=calendar, browser controller never invoked`,
        r.capability?.selected === 'calendar' && !browserWasInvoked(r),
        `capability=${r.capability?.selected} browserInvoked=${browserWasInvoked(r)} result=${r.result.slice(0, 120)}`
      );
    }
  }

  // ---------- 3: UI-path Tasks commands — capability=tasks, browser never invoked ----------
  {
    tasksPendingActionStore.clear(SID);
    const r1 = await runTask({ sessionId: SID, goal: 'What tasks do I have today?', onEvent: () => {}, taskId: nanoid() });
    check(
      '3a. "What tasks do I have today?" -> capability=tasks, browser controller never invoked',
      r1.capability?.selected === 'tasks' && !browserWasInvoked(r1),
      `capability=${r1.capability?.selected} browserInvoked=${browserWasInvoked(r1)}`
    );

    const r2 = await runTask({ sessionId: SID, goal: 'Remind me to call Ramesh tomorrow.', onEvent: () => {}, taskId: nanoid() });
    check(
      '3b. "Remind me to..." -> capability=tasks, proposal only, browser controller never invoked',
      r2.capability?.selected === 'tasks' && !browserWasInvoked(r2) && !!r2.tasks?.pendingAction,
      `capability=${r2.capability?.selected} browserInvoked=${browserWasInvoked(r2)}`
    );
    tasksPendingActionStore.clear(SID);
  }

  // ---------- 4: genuine browser command still reaches the browser capability (through the SAME entry point, not a different code path) ----------
  {
    const r = await runTask({ sessionId: SID, goal: 'Open example.com and tell me the page title', onEvent: () => {}, taskId: nanoid() });
    check(
      '4. "Open example.com and tell me the page title" -> capability=browser (genuine browser task still works)',
      r.capability?.selected === 'browser' || r.capability?.selected === 'read',
      `capability=${r.capability?.selected} result=${r.result?.slice(0, 150)}`
    );
  }

  // ---------- 5: Gmail body containing Calendar/Tasks language stays Gmail, through this same entry point ----------
  {
    const phrases = [
      'Draft an email to Alice saying do I have anything on my calendar today',
      'Draft an email to Alice saying what tasks do I have today',
    ];
    for (const goal of phrases) {
      const r = await runTask({ sessionId: SID, goal, onEvent: () => {}, taskId: nanoid() });
      check(
        `5. "${goal}" -> capability=gmail, never calendar/tasks`,
        r.capability?.selected === 'gmail',
        `capability=${r.capability?.selected}`
      );
    }
  }

  // ---------- 6: voice goes through the identical authoritative path ----------
  {
    const spoken = normalizeVoiceCommand('Jarvis, what is my latest email?');
    const r = await runTask({ sessionId: SID, goal: spoken.command, onEvent: () => {}, taskId: nanoid() });
    check(
      '6. voice-normalized command reaches capability=gmail via the same runTask() path, browser never invoked',
      r.capability?.selected === 'gmail' && !browserWasInvoked(r),
      `command="${spoken.command}" capability=${r.capability?.selected}`
    );
  }

  // ---------- 7: confirmation gates still work through this same production path ----------
  {
    pendingActionStore.clear(SID);
    await runTask({ sessionId: SID, goal: 'Draft an email to explicit@example.com saying hello', onEvent: () => {}, taskId: nanoid() });
    const confirm = await runTask({ sessionId: SID, goal: 'Send it.', onEvent: () => {}, taskId: nanoid() });
    check(
      '7a. Gmail send confirmation still requires the exact phrase through this path',
      confirm.status === 'success' && /^Sent email/.test(confirm.result),
      `result=${confirm.result}`
    );

    calendarPendingActionStore.clear(SID);
    await runTask({ sessionId: SID, goal: 'Schedule a meeting tomorrow at 9 AM for 30 minutes.', onEvent: () => {}, taskId: nanoid() });
    const calConfirm = await runTask({ sessionId: SID, goal: 'Create it.', onEvent: () => {}, taskId: nanoid() });
    check(
      '7b. Calendar create confirmation still requires the exact phrase through this path',
      calConfirm.status === 'success' && /^Created /.test(calConfirm.result),
      `result=${calConfirm.result}`
    );
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
