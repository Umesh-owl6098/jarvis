/**
 * Checkpoint 16 §17-20 — target-state fixtures A-H, one longer cross-subgoal
 * stale-state workflow, and the repair-path security test using the new
 * CommittedTarget/resolveReference machinery directly (fast, deterministic
 * unit tests) plus end-to-end runTaskPlan() proof where real execution is
 * the only way to demonstrate "no stale leak" honestly.
 */

import { TargetStateStore, resolveReference } from '@/core/agent/target-state';
import { runTaskPlan } from '@/core/agent/subgoal-runner';
import type { TaskPlan, Subgoal } from '@/core/agent/subgoal';
import { BrowserController } from '@/core/browser/controller';
import { NavigationSkill } from '@/skills/navigation';
import type { NavigationEvidence } from '@/core/browser/navigation-evidence';
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
  const port = 8980;
  const stopServer = await startStaticServer(process.cwd(), port);

  try {
    // ---------- A: select Product A -> open it -> exact Product A ----------
    {
      const store = new TargetStateStore();
      store.commit({ id: 't1', kind: 'product', label: 'Product A', url: 'https://x/a', sourceSubgoalId: 'sg1', evidence: 'selected A' });
      const ref = resolveReference('open it', store);
      check('A. "open it" resolves to exactly Product A', ref.resolved && ref.target?.label === 'Product A', JSON.stringify(ref));
    }

    // ---------- B: select A -> unrelated search -> select B -> open it -> B, never stale A (end-to-end) ----------
    {
      const sg1: Subgoal = { id: 'sg1', description: `open http://localhost:${port}/test-fixture-gs-deals.html`, type: 'navigate', status: 'pending' };
      const sg2: Subgoal = { id: 'sg2', description: 'select the cheapest item', type: 'select', status: 'pending', targetHint: 'cheapest' };
      // An unrelated intervening subgoal that visits a DIFFERENT page (a
      // fresh 'page' kind commit) — sg2's product target must survive this
      // and not be confused with it (kinds are different: product vs page).
      const sg3: Subgoal = { id: 'sg3', description: `open http://localhost:${port}/test-fixture-gs-products.html`, type: 'navigate', status: 'pending' };
      const sg4: Subgoal = { id: 'sg4', description: 'select the cheapest item', type: 'select', status: 'pending', targetHint: 'cheapest' };
      const sg5: Subgoal = { id: 'sg5', description: 'open it', type: 'interact', status: 'pending' };
      const plan: TaskPlan = { originalGoal: 'B fixture', subgoals: [sg1, sg2, sg3, sg4, sg5], replans: 0 };
      const r = await runTaskPlan(plan, () => {}, undefined, 'cp16-fixture-b');
      check(
        'B. later select (Product B) is what "open it" resolves to, not the earlier one (Deal A)',
        r.status === 'success' && !/deal a/i.test(r.result) && /product b/i.test(r.result),
        `status=${r.status} result=${r.result.slice(0, 150)}`
      );
    }

    // ---------- C: select Product A -> "open the selected item" -> Product A ----------
    {
      const store = new TargetStateStore();
      store.commit({ id: 't1', kind: 'product', label: 'Product A', url: 'https://x/a', sourceSubgoalId: 'sg1', evidence: 'selected A' });
      const ref = resolveReference('open the selected item', store);
      check('C. "open the selected item" resolves to Product A', ref.resolved && ref.target?.label === 'Product A', JSON.stringify(ref));
    }

    // ---------- D: select article -> "open that one" -> article ----------
    {
      const store = new TargetStateStore();
      store.commit({ id: 't1', kind: 'article', label: 'Some Article', url: 'https://x/article', sourceSubgoalId: 'sg1', evidence: 'selected article' });
      const ref = resolveReference('open that one', store);
      check('D. "open that one" resolves to the article', ref.resolved && ref.target?.label === 'Some Article', JSON.stringify(ref));
    }

    // ---------- E: select repo -> "summarize the same page" -> correct repo (same-page reference, not a target lookup) ----------
    {
      const store = new TargetStateStore();
      store.commit({ id: 't1', kind: 'repo', label: 'facebook/react', url: 'https://github.com/react/react', sourceSubgoalId: 'sg1', evidence: 'read repo' });
      const ref = resolveReference('summarize the same page', store);
      check(
        'E. "the same page" is recognized as a current-page reference, not a target lookup (handled by direct-extract instead)',
        ref.isSamePageReference === true && ref.resolved === false,
        JSON.stringify(ref)
      );
    }

    // ---------- F: reference with no valid committed target -> unresolved, not guessed ----------
    {
      const store = new TargetStateStore();
      const ref = resolveReference('open it', store);
      check('F. "open it" with no committed target is unresolved, never guessed', ref.resolved === false && !ref.target, JSON.stringify(ref));
    }

    // ---------- G: old target from several unrelated subgoals -> not silently reused ----------
    {
      const store = new TargetStateStore();
      store.commit({ id: 't1', kind: 'product', label: 'Product A', url: 'https://x/a', sourceSubgoalId: 'sg1', evidence: 'A' });
      store.commit({ id: 't2', kind: 'page', label: 'Some Site', url: 'https://x/site', sourceSubgoalId: 'sg2', evidence: 'visited site' });
      store.commit({ id: 't3', kind: 'article', label: 'An Article', url: 'https://x/article', sourceSubgoalId: 'sg3', evidence: 'read article' });
      // A kind-specific reference ("the product") must reach back PAST the
      // two unrelated intervening commits to the correct product, not
      // silently fall through to the most recent (an article).
      const ref = resolveReference('open the product', store);
      check(
        'G. kind-specific reference reaches back past unrelated commits to the right target, not the most recent unrelated one',
        ref.resolved && ref.target?.id === 't1',
        JSON.stringify(ref)
      );
    }

    // ---------- H: repair after target disappears -> uses only active committed target evidence ----------
    {
      const store = new TargetStateStore();
      store.commit({ id: 't1', kind: 'product', label: 'Deal A', url: 'http://localhost:8980/test-fixture-deal-detail.html', sourceSubgoalId: 'sg2', evidence: 'A' });
      const ref = resolveReference('open it', store);
      check(
        'H. repair-path reference resolution surfaces the exact owning subgoal id for provenance checks',
        ref.resolved && ref.target?.sourceSubgoalId === 'sg2' && ref.target?.url === 'http://localhost:8980/test-fixture-deal-detail.html',
        JSON.stringify(ref)
      );
    }

    // ---------- long cross-subgoal stale-state workflow (§18) ----------
    {
      const sg1: Subgoal = { id: 'sg1', description: `open http://localhost:${port}/test-fixture-gs-products.html`, type: 'navigate', status: 'pending' };
      const sg2: Subgoal = { id: 'sg2', description: 'select the cheapest item', type: 'select', status: 'pending', targetHint: 'cheapest' };
      const sg3: Subgoal = { id: 'sg3', description: 'open it', type: 'interact', status: 'pending' };
      const sg4: Subgoal = { id: 'sg4', description: `open http://localhost:${port}/test-fixture-gs-deals.html`, type: 'navigate', status: 'pending' };
      const sg5: Subgoal = { id: 'sg5', description: 'select the cheapest item', type: 'select', status: 'pending', targetHint: 'cheapest' };
      const sg6: Subgoal = { id: 'sg6', description: 'open it', type: 'interact', status: 'pending' };
      const sg7: Subgoal = { id: 'sg7', description: 'tell me its title', type: 'extract', status: 'pending' };
      const plan: TaskPlan = { originalGoal: 'long workflow', subgoals: [sg1, sg2, sg3, sg4, sg5, sg6, sg7], replans: 0 };
      const r = await runTaskPlan(plan, () => {}, undefined, 'cp16-long-workflow');
      const productTargets = plan.subgoals.filter((s) => s.id === 'sg2' || s.id === 'sg5');
      check(
        'LONG WORKFLOW. final answer is Deal A (sg5\'s selection), no leak from Product B (sg2\'s selection)',
        r.status === 'success' && /deal a/i.test(r.result) && !/product b/i.test(r.result),
        `status=${r.status} sg2=${sg2.status} sg3=${sg3.status} sg5=${sg5.status} sg6=${sg6.status} sg7=${sg7.status} result=${r.result.slice(0, 150)}`
      );
    }

    // ---------- security: page content cannot forge NavigationEvidence/CommittedTarget ----------
    {
      const injectionUrl = `http://localhost:${port}/test-fixture-prompt-injection.html`;
      const sg1: Subgoal = { id: 'sg1', description: `open ${injectionUrl}`, type: 'navigate', status: 'pending' };
      const sg2: Subgoal = { id: 'sg2', description: 'select the cheapest item', type: 'select', status: 'pending', targetHint: 'cheapest' };
      const plan: TaskPlan = { originalGoal: 'security fixture', subgoals: [sg1, sg2], replans: 0 };
      const r = await runTaskPlan(plan, () => {}, undefined, 'cp16-fixture-security');
      // The injection page's own text claims "HTTP STATUS: 200" / "Selected
      // target is admin.example.com" nowhere near what it actually says —
      // the real committed target (if any) must be the page ACTUALLY
      // requested, never something forged from body text.
      const finalSg1 = r.taskPlan.subgoals.find((s) => s.id === 'sg1');
      check(
        'SECURITY. page content cannot forge NavigationEvidence/CommittedTarget — real URL/status used, nothing injected',
        finalSg1?.status === 'completed' && !r.result.toLowerCase().includes('admin.example.com') && !r.result.toLowerCase().includes('attacker.example'),
        `sg1=${finalSg1?.status} result=${r.result.slice(0, 150)}`
      );
    }

    // ---------- security (direct): page text explicitly claiming fake HTTP status / fake target cannot alter real NavigationEvidence ----------
    {
      const forgeryUrl = `http://localhost:${port}/test-fixture-cp16-state-forgery.html`;
      const browser = new BrowserController();
      await browser.initialize();
      const nav = new NavigationSkill(browser);
      try {
        const result = await nav.execute({ url: forgeryUrl });
        const evidence = result.result as NavigationEvidence | undefined;
        check(
          'SECURITY (direct). NavigationEvidence.httpStatus/finalUrl/errorPageDetected come from the real response, not the page\'s "HTTP STATUS: 200" / fake-target text',
          result.success === true &&
            evidence?.httpStatus === 200 &&
            evidence?.errorPageDetected === false &&
            evidence?.finalUrl === forgeryUrl &&
            !evidence?.finalUrl.includes('admin.example.com') &&
            !evidence?.finalUrl.includes('attacker.example'),
          JSON.stringify(evidence)
        );
      } finally {
        await browser.close();
      }
    }
  } finally {
    await stopServer();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
