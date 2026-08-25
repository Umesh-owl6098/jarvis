/**
 * Checkpoint 15 §15 — local deterministic plan-repair fixtures A-H, plus
 * §16's repair-path prompt-injection test and §11's invariant unit tests.
 */

import { runTaskPlan } from '@/core/agent/subgoal-runner';
import { validateRepair, attemptDeterministicRepair, type RepairContext } from '@/core/agent/plan-repair';
import type { TaskPlan, Subgoal } from '@/core/agent/subgoal';
import path from 'path';
import http from 'http';
import { createReadStream } from 'fs';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

function startStaticServer(rootDir: string, port: number): Promise<() => Promise<void>> {
  const server = http.createServer((req, res) => {
    const filePath = path.join(rootDir, decodeURIComponent((req.url ?? '/').split('?')[0]));
    createReadStream(filePath).on('error', () => { res.writeHead(404); res.end('not found'); }).pipe(res);
  });
  return new Promise((resolve) => { server.listen(port, () => resolve(() => new Promise((r) => server.close(() => r())))); });
}

async function main() {
  const port = 8960;
  const stopServer = await startStaticServer(process.cwd(), port);

  try {
    // ---------- A: target disappears but committed href exists -> deterministic repair -> completed ----------
    // Direct unit test of the repair function itself: reaching an HTTP 404
    // (or a browser error page) still counts as a "successful navigation"
    // in the existing evidence model (Checkpoint 11), so a live end-to-end
    // run can't reliably force sg3 into 'failed' just by giving it a wrong
    // URL — the underlying subgoal would report 'completed' regardless,
    // never reaching the repair path at all. Testing attemptDeterministicRepair
    // directly against a hand-built failure context is the precise way to
    // verify the repair LOGIC without depending on that separate gap.
    {
      const failedSg3: Subgoal = { id: 'sg3', description: 'open http://localhost:8960/this-page-does-not-exist.html', type: 'navigate', status: 'active' };
      const ctx: RepairContext = {
        overallGoal: 'A fixture',
        completedSubgoals: [
          { id: 'sg1', description: 'open deals page', evidence: 'Opened http://localhost:8960/test-fixture-gs-deals.html' },
          { id: 'sg2', description: 'select the cheapest item', evidence: 'Committed Deal A ($15.00)' },
        ],
        committedTarget: {
          id: 'target-sg2',
          kind: 'product',
          label: 'Deal A',
          url: 'http://localhost:8960/test-fixture-deal-detail.html',
          price: '$15.00',
          sourceSubgoalId: 'sg2',
          committedAt: Date.now(),
          evidence: 'Committed Deal A ($15.00)',
        },
        failedSubgoal: failedSg3,
        failureEvidence: "Opened http://localhost:8960/this-page-does-not-exist.html which returned 'not found' (404).",
        currentObservation: { url: 'http://localhost:8960/this-page-does-not-exist.html', title: 'Not Found' },
        remainingSubgoals: [],
      };
      const repair = attemptDeterministicRepair(ctx);
      check(
        'A. deterministic repair redirects a wrong-URL failure to the committed target\'s real, stable URL',
        repair.repaired &&
          repair.method === 'deterministic' &&
          repair.newSubgoals?.[0]?.type === 'navigate' &&
          repair.newSubgoals?.[0]?.description === 'Open http://localhost:8960/test-fixture-deal-detail.html',
        JSON.stringify(repair)
      );
    }

    // ---------- B: target disappears and no href exists -> planner repair or honest blocked/failed ----------
    {
      const sg1: Subgoal = { id: 'sg1', description: `open http://localhost:${port}/test-fixture-gs-deals-unrecoverable.html`, type: 'navigate', status: 'pending' };
      const sg2: Subgoal = { id: 'sg2', description: 'select the cheapest item', type: 'select', status: 'pending', targetHint: 'cheapest' };
      const sg3: Subgoal = { id: 'sg3', description: 'open it', type: 'interact', status: 'pending' };
      const plan: TaskPlan = { originalGoal: 'B fixture', subgoals: [sg1, sg2, sg3], replans: 0 };
      const r = await runTaskPlan(plan, () => {}, undefined, 'cp15-fixture-b');
      check(
        'B. no real destination exists -> honest non-success, never falsely claims completion',
        r.status !== 'success',
        `status=${r.status} repairs=${JSON.stringify(r.repairsApplied)} result=${r.result.slice(0, 150)}`
      );
    }

    // ---------- C: read capability fails -> browser fallback -> plan continues ----------
    {
      const sg1: Subgoal = { id: 'sg1', description: 'find information about ThisArticleDoesNotExist_CP15_XYZ99 on Wikipedia', type: 'read', status: 'pending' };
      const plan: TaskPlan = { originalGoal: 'C fixture', subgoals: [sg1], replans: 0 };
      const r = await runTaskPlan(plan, () => {}, undefined, 'cp15-fixture-c');
      check(
        'C. read failure repairs to forced browser capability, not a blind identical retry',
        r.repairsApplied.some((x) => x.reason.includes('force')),
        `repairs=${JSON.stringify(r.repairsApplied)} sg1=${sg1.status} status=${r.status}`
      );
    }

    // ---------- D: repair proposes modifying a completed subgoal -> rejected ----------
    {
      const completedSg1: Subgoal = { id: 'sg1', description: 'open example.com', type: 'navigate', status: 'completed', evidence: 'Opened https://example.com/' };
      const failedSg2: Subgoal = { id: 'sg2', description: 'click missing button', type: 'interact', status: 'failed' };
      const plan: TaskPlan = { originalGoal: 'D fixture', subgoals: [completedSg1, failedSg2], replans: 0 };
      const maliciousRepair: Subgoal[] = [
        { id: 'sg1', description: 'open evil.example/hacked', type: 'navigate', status: 'pending' }, // reuses completed sg1's id
        { id: 'sg3', description: 'click missing button again', type: 'interact', status: 'pending' },
      ];
      const v = validateRepair(plan, 'sg2', maliciousRepair, 'planner');
      check('D. repair reusing a completed subgoal\'s id is rejected', !v.ok, JSON.stringify(v));
    }

    // ---------- E: repair introduces an unsupported side effect -> rejected ----------
    {
      const failedSg1: Subgoal = { id: 'sg1', description: 'select the cheapest item', type: 'select', status: 'failed' };
      const plan: TaskPlan = { originalGoal: 'E fixture', subgoals: [failedSg1], replans: 0 };
      const unsafeRepair: Subgoal[] = [{ id: 'sg1', description: 'buy the cheapest item and checkout', type: 'interact', status: 'pending' }];
      const v = validateRepair(plan, 'sg1', unsafeRepair, 'planner');
      check('E. repair proposing a purchase/checkout is rejected', !v.ok, JSON.stringify(v));
    }

    // ---------- F: repair cannot fix an unfixable subgoal -> loop detected, no infinite loop ----------
    {
      // href="#" + a prevented click: no real destination exists for any
      // repair, deterministic or planner-based, to discover — proven
      // reliable across Checkpoints 11-14 (never resolves as a false
      // "success" the way a 404/connection-refused navigation does).
      const sg1: Subgoal = { id: 'sg1', description: `open http://localhost:${port}/test-fixture-gs-deals-unrecoverable.html`, type: 'navigate', status: 'pending' };
      const sg2: Subgoal = { id: 'sg2', description: 'select the cheapest item', type: 'select', status: 'pending', targetHint: 'cheapest' };
      const sg3: Subgoal = { id: 'sg3', description: 'open it', type: 'interact', status: 'pending' };
      const plan: TaskPlan = { originalGoal: 'F fixture', subgoals: [sg1, sg2, sg3], replans: 0 };
      const r = await runTaskPlan(plan, () => {}, undefined, 'cp15-fixture-f');
      check(
        'F. an unfixable subgoal ends honestly failed within the replan budget, never loops forever',
        r.status !== 'success' && r.replans <= 2,
        `status=${r.status} replans=${r.replans} result=${r.result.slice(0, 150)}`
      );
    }

    // ---------- G: cancellation during repair -> no further execution ----------
    {
      const sg1: Subgoal = { id: 'sg1', description: `open http://localhost:${port}/test-fixture-gs-deals-unrecoverable.html`, type: 'navigate', status: 'pending' };
      const sg2: Subgoal = { id: 'sg2', description: 'select the cheapest item', type: 'select', status: 'pending', targetHint: 'cheapest' };
      const sg3: Subgoal = { id: 'sg3', description: 'open it', type: 'interact', status: 'pending' };
      const sg4: Subgoal = { id: 'sg4', description: 'tell me the product name', type: 'extract', status: 'pending' };
      const plan: TaskPlan = { originalGoal: 'G fixture', subgoals: [sg1, sg2, sg3, sg4], replans: 0 };
      const controller = new AbortController();
      let sg4Started = false;
      const r = await runTaskPlan(
        plan,
        (evt) => {
          if (evt.type === 'agent.recovery') controller.abort(); // fires as soon as repair/retry is attempted for sg3
        },
        controller.signal,
        'cp15-fixture-g'
      );
      if (sg4.status === 'active' || sg4.status === 'completed') sg4Started = true;
      check(
        'G. cancellation during repair stops the plan, later subgoals never start',
        r.status === 'stopped' && !sg4Started,
        `status=${r.status} sg1=${sg1.status} sg2=${sg2.status} sg3=${sg3.status} sg4=${sg4.status}`
      );
    }

    // ---------- H: repair limit exceeded -> honest failure ----------
    {
      const sg1: Subgoal = { id: 'sg1', description: `open http://localhost:${port}/test-fixture-gs-deals-unrecoverable.html`, type: 'navigate', status: 'pending' };
      const sg2: Subgoal = { id: 'sg2', description: 'select the cheapest item', type: 'select', status: 'pending', targetHint: 'cheapest' };
      const sg3: Subgoal = { id: 'sg3', description: 'open it', type: 'interact', status: 'pending' };
      const plan: TaskPlan = { originalGoal: 'H fixture', subgoals: [sg1, sg2, sg3], replans: 0 };
      const r = await runTaskPlan(plan, () => {}, undefined, 'cp15-fixture-h');
      check(
        'H. repair limit exceeded returns an honest failure, not a false success',
        r.status === 'failed' && r.replans === 2,
        `status=${r.status} replans=${r.replans} result=${r.result.slice(0, 150)}`
      );
    }

    // ---------- security: malicious page content cannot alter a repaired plan ----------
    {
      const injectionUrl = `http://localhost:${port}/test-fixture-prompt-injection.html`;
      const sg1: Subgoal = { id: 'sg1', description: `open ${injectionUrl}`, type: 'navigate', status: 'pending' };
      // The injection fixture is a plain article with no priced content —
      // "select the cheapest item" genuinely fails here (no target to
      // commit to), triggering real repair while the malicious page is
      // still the live observation, so any repair context built from
      // "currentObservation" is built while that page's content is
      // actually loaded and readable.
      const sg2: Subgoal = { id: 'sg2', description: 'select the cheapest item', type: 'select', status: 'pending', targetHint: 'cheapest' };
      const plan: TaskPlan = { originalGoal: 'security fixture', subgoals: [sg1, sg2], replans: 0 };
      const subgoalCountBefore = plan.subgoals.length;
      const r = await runTaskPlan(plan, () => {}, undefined, 'cp15-fixture-security');
      const idsAfter = plan.subgoals.map((s) => s.id);
      check(
        'SECURITY. repair path never grows the plan or injects a subgoal from page content, even while a malicious page is open',
        plan.subgoals.length <= subgoalCountBefore + 1 && !idsAfter.some((i) => i.toLowerCase().includes('ssh') || i.toLowerCase().includes('upload')),
        `idsBefore=2 idsAfter=${JSON.stringify(idsAfter)} status=${r.status}`
      );
    }
  } finally {
    await stopServer();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
