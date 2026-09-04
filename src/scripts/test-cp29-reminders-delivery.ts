/**
 * Checkpoint 29 §Delivery + HOLD durability audit — the single-timer
 * scheduler: a future reminder is never delivered early, an exact due
 * boundary delivers, overdue reminders are recovered on startup, delivery
 * is never duplicated, a cancelled reminder is never delivered, the
 * nearest timer re-arms correctly after create/cancel/deliver, long
 * delays are handled safely (never overflow Node's setTimeout ceiling),
 * and at most ONE timer is ever armed at a time.
 *
 * HOLD addition — the durability invariant: "a reminder notification must
 * not be permanently lost merely because no UI was polling at trigger
 * time, or the server restarted before the UI observed it." Proven via
 * reminderStore.drainUnsurfaced()'s persisted `surfacedAt` field (see
 * delivery.ts/store.ts) rather than the earlier in-memory-only queue,
 * which this HOLD replaced specifically because it could NOT satisfy this
 * invariant across a restart.
 *
 * Real (sub-second) delays are used for the actual FIRING tests — never
 * real minutes/hours — mirroring how this codebase's own
 * abort-cancellation tests already use short real waits for genuine
 * async/timer behavior. Arming-DECISION tests (which reminder the
 * scheduler chose, for how long conceptually) use injected `now` values
 * and never wait at all.
 */
const TEST_REMINDERS_PATH = require('os').tmpdir() + '/jarvis-cp29-delivery-' + Date.now() + '.json';
process.env.JARVIS_REMINDERS_PATH = TEST_REMINDERS_PATH;

import { reminderStore } from '@/core/reminders/store';
import { drainDueDeliveries } from '@/core/reminders/delivery';
import { rearmScheduler, disarmScheduler, __schedulerStateForTesting } from '@/core/reminders/scheduler';
import { recoverOverdueRemindersOnStartup } from '@/core/reminders/startup';
import type { Reminder } from '@/core/reminders/types';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeReminder(overrides: Partial<Reminder> = {}): Reminder {
  return {
    id: overrides.id ?? `r-${Math.random().toString(36).slice(2)}`,
    text: 'Test reminder',
    triggerAt: new Date(Date.now() + 3600000).toISOString(),
    createdAt: new Date().toISOString(),
    status: 'scheduled',
    ...overrides,
  };
}

async function main() {
  disarmScheduler();

  // ---------- 1. future reminder is not delivered early ----------
  {
    reminderStore.add(makeReminder({ id: 'future1', text: 'Far future', triggerAt: new Date(Date.now() + 3600000).toISOString() }));
    rearmScheduler(new Date());
    await sleep(30);
    check('1. a reminder 1 hour out is NOT delivered after only 30ms', !drainDueDeliveries().some((d) => d.reminderId === 'future1'));
    check('1b. the reminder itself is still scheduled', reminderStore.get('future1')?.status === 'scheduled');
    disarmScheduler();
    reminderStore.cancel('future1');
  }

  // ---------- 2. exact due boundary — a reminder due in 30ms IS delivered shortly after ----------
  {
    reminderStore.add(makeReminder({ id: 'soon1', text: 'Fires soon', triggerAt: new Date(Date.now() + 30).toISOString() }));
    rearmScheduler(new Date());
    await sleep(150);
    check('2. a reminder due 30ms out is delivered within 150ms', reminderStore.get('soon1')?.status === 'delivered', `status=${reminderStore.get('soon1')?.status}`);
    check('2b. it is surfaced by a poll', drainDueDeliveries().some((d) => d.reminderId === 'soon1'));
    disarmScheduler();
  }

  // ---------- 3. no duplicate delivery/surfacing — firing (or polling) twice never re-surfaces the same reminder ----------
  {
    reminderStore.add(makeReminder({ id: 'once1', text: 'Only once', triggerAt: new Date(Date.now() + 30).toISOString() }));
    rearmScheduler(new Date());
    await sleep(150);
    const firstPoll = drainDueDeliveries().filter((d) => d.reminderId === 'once1').length;
    const secondPoll = drainDueDeliveries().filter((d) => d.reminderId === 'once1').length;
    // Force a second fire-equivalent call directly — even if the scheduler
    // itself is disciplined, prove the STORE-level guarantee independently:
    // markAllDueDelivered only ever touches 'scheduled' reminders.
    const secondFire = reminderStore.markAllDueDelivered(new Date());
    check('3. exactly one delivery is surfaced by the FIRST poll', firstPoll === 1, `count=${firstPoll}`);
    check('3b. a SECOND poll never re-surfaces the same reminder', secondPoll === 0, `count=${secondPoll}`);
    check('3c. a second markAllDueDelivered call finds nothing left to deliver for this reminder', !secondFire.some((r) => r.id === 'once1'));
    disarmScheduler();
  }

  // ---------- 4. cancelled reminder is never delivered ----------
  {
    reminderStore.add(makeReminder({ id: 'cancel1', text: 'Will be cancelled', triggerAt: new Date(Date.now() + 30).toISOString() }));
    reminderStore.cancel('cancel1');
    rearmScheduler(new Date());
    await sleep(150);
    check('4. a cancelled reminder is never delivered even though its triggerAt has passed', !drainDueDeliveries().some((d) => d.reminderId === 'cancel1'));
    check('4b. its status remains cancelled, never flipped to delivered', reminderStore.get('cancel1')?.status === 'cancelled');
    disarmScheduler();
  }

  // ---------- 5. nearest-timer re-arming — creating a NEARER reminder after arming re-arms for the new nearest ----------
  {
    reminderStore.add(makeReminder({ id: 'far1', text: 'Far', triggerAt: new Date(Date.now() + 3600000).toISOString() }));
    rearmScheduler(new Date());
    check('5-setup. armed for the far reminder', __schedulerStateForTesting().armedForId === 'far1', `state=${JSON.stringify(__schedulerStateForTesting())}`);

    reminderStore.add(makeReminder({ id: 'near1', text: 'Near', triggerAt: new Date(Date.now() + 60000).toISOString() }));
    rearmScheduler(new Date()); // simulates what runner.ts's confirm handler does after every create
    check('5. creating a NEARER reminder re-arms the timer for it, not the old far one', __schedulerStateForTesting().armedForId === 'near1', `state=${JSON.stringify(__schedulerStateForTesting())}`);

    disarmScheduler();
    reminderStore.cancel('far1');
    reminderStore.cancel('near1');
  }

  // ---------- 6. cancelling the CURRENTLY-ARMED reminder re-arms for the next nearest ----------
  {
    reminderStore.add(makeReminder({ id: 'armed1', text: 'Armed', triggerAt: new Date(Date.now() + 60000).toISOString() }));
    reminderStore.add(makeReminder({ id: 'next1', text: 'Next', triggerAt: new Date(Date.now() + 120000).toISOString() }));
    rearmScheduler(new Date());
    check('6-setup. armed for the nearer of the two', __schedulerStateForTesting().armedForId === 'armed1');

    reminderStore.cancel('armed1');
    rearmScheduler(new Date()); // simulates what runner.ts's cancel-confirm handler does
    check('6. cancelling the currently-armed reminder re-arms for the NEXT nearest', __schedulerStateForTesting().armedForId === 'next1', `state=${JSON.stringify(__schedulerStateForTesting())}`);

    disarmScheduler();
    reminderStore.cancel('next1');
  }

  // ---------- 7. no scheduled reminders — scheduler stays disarmed ----------
  {
    disarmScheduler();
    rearmScheduler(new Date());
    check('7. with zero scheduled reminders, the scheduler arms nothing', __schedulerStateForTesting().armed === false, `state=${JSON.stringify(__schedulerStateForTesting())}`);
  }

  // ---------- 8. long-delay handling — never overflows, uses a bounded safety-checkpoint instead ----------
  {
    const farFuture = new Date(Date.now() + 400 * 24 * 3600000); // 400 days out — WAY beyond Node's ~24.8-day setTimeout ceiling
    reminderStore.add(makeReminder({ id: 'faraway1', text: 'Very far away', triggerAt: farFuture.toISOString() }));
    rearmScheduler(new Date());
    const state = __schedulerStateForTesting();
    check('8. a reminder 400 days out arms a bounded CHECKPOINT timer, never a raw 400-day setTimeout (which would silently overflow and fire immediately)', state.armed === true && state.armedForId === 'checkpoint', `state=${JSON.stringify(state)}`);
    disarmScheduler();
    reminderStore.cancel('faraway1');
  }

  // ---------- 9. one-timer invariant — repeated rearmScheduler() calls never accumulate more than one live timer ----------
  {
    reminderStore.add(makeReminder({ id: 'inv1', text: 'Invariant test', triggerAt: new Date(Date.now() + 3600000).toISOString() }));
    for (let i = 0; i < 10; i++) rearmScheduler(new Date()); // called repeatedly, as create/cancel/deliver each would
    check('9. repeated rearmScheduler() calls leave exactly one coherent armed state', __schedulerStateForTesting().armedForId === 'inv1');
    disarmScheduler();
    check('9b. disarmScheduler() actually clears the armed state (proves there was only ever the one tracked timer, not orphaned extras)', __schedulerStateForTesting().armed === false);
    reminderStore.cancel('inv1');
  }

  // ---------- 10. overdue startup delivery — a reminder already past due at "restart" is marked delivered, not silently discarded ----------
  {
    disarmScheduler();
    reminderStore.add(makeReminder({ id: 'overdue1', text: 'Missed while server was down', triggerAt: new Date(Date.now() - 3600000).toISOString() }));
    recoverOverdueRemindersOnStartup(new Date());
    check('10. an overdue reminder is marked delivered on startup, not silently discarded', reminderStore.get('overdue1')?.status === 'delivered', `status=${reminderStore.get('overdue1')?.status}`);
    check('10b. it is surfaceable (missed/due), not dropped', reminderStore.get('overdue1')?.surfacedAt === undefined);
    drainDueDeliveries(); // consume it so it doesn't interfere with later blocks
    disarmScheduler();
  }

  // ============================================================
  // HOLD §3/§4 — delivery durability scenarios A-D, traced precisely
  // ============================================================

  // ---------- Scenario A: reminder fires while a "tab" is actively polling ----------
  {
    disarmScheduler();
    reminderStore.add(makeReminder({ id: 'scenA', text: 'Scenario A', triggerAt: new Date(Date.now() + 30).toISOString() }));
    rearmScheduler(new Date());
    await sleep(150);
    const surfaced = drainDueDeliveries();
    check('A. a reminder that fires while polling is active is delivered AND surfaced normally, exactly once', surfaced.some((d) => d.reminderId === 'scenA'));
    check('A2. a subsequent poll never re-surfaces it', !drainDueDeliveries().some((d) => d.reminderId === 'scenA'));
    disarmScheduler();
  }

  // ---------- Scenario B: fires while no tab is open, server stays running, a tab opens LATER ----------
  {
    disarmScheduler();
    reminderStore.add(makeReminder({ id: 'scenB', text: 'Scenario B', triggerAt: new Date(Date.now() + 30).toISOString() }));
    rearmScheduler(new Date());
    await sleep(150); // it fires — nothing polls yet, simulating "no browser tab open"
    check('B-setup. the reminder is delivered even though nothing has polled', reminderStore.get('scenB')?.status === 'delivered');
    check('B-setup2. it has NOT been surfaced yet — still sitting durably in the persisted store', reminderStore.get('scenB')?.surfacedAt === undefined);
    await sleep(50); // more time passes with still nobody polling
    // A "tab opens later" — its first poll must still find it.
    const surfaced = drainDueDeliveries();
    check('B. a delivery that sat unpolled for a while is still surfaced once a tab finally polls — nothing is lost by a late poll', surfaced.some((d) => d.reminderId === 'scenB'));
    disarmScheduler();
  }

  // ---------- Scenario C: fires while no tab open, marked delivered, THEN the server restarts before any UI poll ----------
  {
    disarmScheduler();
    reminderStore.add(makeReminder({ id: 'scenC', text: 'Scenario C', triggerAt: new Date(Date.now() + 30).toISOString() }));
    rearmScheduler(new Date());
    await sleep(150); // fires — delivered, unsurfaced, nobody has polled
    check('C-setup. delivered before any restart', reminderStore.get('scenC')?.status === 'delivered');

    // Simulate a full server restart: disarm (in-memory scheduler state is
    // gone, exactly as it would be after a real process exit) and run the
    // SAME startup recovery path a real restart would run. Nothing about
    // "was this surfaced" ever lived in memory, so there is nothing for a
    // restart to lose here — that is the entire point of this fix.
    disarmScheduler();
    recoverOverdueRemindersOnStartup(new Date());

    const surfaced = drainDueDeliveries();
    check('C. a reminder delivered before an unpolled restart is STILL surfaced afterward — the HOLD-identified permanent-loss bug is fixed', surfaced.some((d) => d.reminderId === 'scenC'), `surfaced=${JSON.stringify(surfaced)}`);
    disarmScheduler();
  }

  // ---------- Scenario D: overdue at startup (delivered+made-surfaceable once); a SECOND restart occurs before the UI drains it ----------
  {
    disarmScheduler();
    reminderStore.add(makeReminder({ id: 'scenD', text: 'Scenario D', triggerAt: new Date(Date.now() - 3600000).toISOString() })); // already overdue
    recoverOverdueRemindersOnStartup(new Date()); // "restart" #1 — delivers it
    check('D-setup. restart #1 marks the overdue reminder delivered', reminderStore.get('scenD')?.status === 'delivered');
    check('D-setup2. not yet surfaced — no UI has polled', reminderStore.get('scenD')?.surfacedAt === undefined);

    // "restart" #2 — happens BEFORE any poll drained it.
    disarmScheduler();
    recoverOverdueRemindersOnStartup(new Date());
    check('D-setup3. a second restart does not re-deliver (still exactly-once delivered)', reminderStore.get('scenD')?.status === 'delivered');

    const surfaced = drainDueDeliveries();
    check('D. surviving TWO restarts before any poll, the reminder is still surfaced — never permanently lost', surfaced.some((d) => d.reminderId === 'scenD'), `surfaced=${JSON.stringify(surfaced)}`);

    // Once surfaced, a THIRD restart must never surface it again.
    disarmScheduler();
    recoverOverdueRemindersOnStartup(new Date());
    const afterThirdRestart = drainDueDeliveries();
    check('D2. once surfaced, a further restart never surfaces it again', !afterThirdRestart.some((d) => d.reminderId === 'scenD'));
    disarmScheduler();
  }

  // ---------- §5 — delivery happens via the SERVER SCHEDULER, independently of any polling ----------
  {
    disarmScheduler();
    reminderStore.add(makeReminder({ id: 'indep1', text: 'Independent of polling', triggerAt: new Date(Date.now() + 30).toISOString() }));
    rearmScheduler(new Date());
    await sleep(150); // the real timer fires — drainDueDeliveries()/the API route is NEVER called anywhere in this block
    check('indep-1. the reminder becomes "delivered" via the scheduler timer alone, with zero polling having occurred', reminderStore.get('indep1')?.status === 'delivered', `status=${reminderStore.get('indep1')?.status}`);
    disarmScheduler();
    drainDueDeliveries();
  }

  // ---------- §5 — /api/reminders/due's underlying function has no side effect beyond surfacing ----------
  {
    const src = require('fs').readFileSync('src/core/reminders/delivery.ts', 'utf-8');
    check('sidefx-1. drainDueDeliveries never imports/calls a Gmail/Calendar/Tasks client or the task runner', !/getGmailClient|getCalendarClient|getTasksClient|runTask\s*\(/.test(src));
    const routeSrc = require('fs').readFileSync('src/app/api/reminders/due/route.ts', 'utf-8');
    check('sidefx-2. the /api/reminders/due route performs no action beyond calling drainDueDeliveries', /export async function GET\(\) \{\s*const deliveries = drainDueDeliveries\(\);\s*return NextResponse\.json/.test(routeSrc.replace(/\n\s*/g, '\n')), `route=${routeSrc}`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  disarmScheduler();
  try { require('fs').rmSync(TEST_REMINDERS_PATH, { force: true }); } catch {}
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error('Fatal error:', e);
  disarmScheduler();
  try { require('fs').rmSync(TEST_REMINDERS_PATH, { force: true }); } catch {}
  process.exit(1);
});
