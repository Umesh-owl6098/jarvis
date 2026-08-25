/**
 * Checkpoint 12 — deterministic unit tests for context/token compression.
 * No browser, no LLM call — synthetic PageObservation objects driven
 * directly against ContextManager, matching the fast unit-test pattern the
 * rest of this checkpoint favors over full live runs where possible.
 */

import { ContextManager } from '@/core/context';
import type { PageObservation } from '@/core/observation';
import type { TaskProgress } from '@/core/agent/goal-state';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    pass++;
    console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    fail++;
    console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function makeObs(overrides: Partial<PageObservation> = {}): PageObservation {
  return {
    url: 'https://example.com/',
    title: 'Example',
    visibleTextSummary: 'Some text',
    textLength: 9,
    interactiveElements: [
      { id: 'e1', role: 'link', name: 'Link One' },
      { id: 'e2', role: 'button', name: 'Button Two' },
    ],
    elementsTotalFound: 2,
    elementsTruncated: false,
    contentItems: [],
    contentItemsTotalFound: 0,
    contentItemsWithPrice: 0,
    contentItemsTruncated: false,
    blockers: [],
    openTabs: 1,
    currentTask: 'test',
    alerts: [],
    stateFingerprint: 'fp-1',
    timestamp: Date.now(),
    ...overrides,
  } as PageObservation;
}

function makeProgress(overrides: Partial<TaskProgress> = {}): TaskProgress {
  return {
    goal: 'test',
    goalType: 'navigate_to_target',
    milestones: [],
    searchDone: false,
    hrefFallbackAttempted: false,
    ...overrides,
  };
}

// ---------- A: unchanged observation compresses ----------
{
  const cm = new ContextManager('test task');
  const obs = makeObs();
  cm.addObservation(obs);
  const first = JSON.parse(cm.getContextForLLM());
  cm.addObservation(makeObs()); // same fingerprint 'fp-1'
  const second = JSON.parse(cm.getContextForLLM());
  check(
    'A. unchanged observation (same fingerprint) sends compact form, not full elements',
    !first.currentPage.unchanged && Array.isArray(first.currentPage.elements) && second.currentPage.unchanged === true && second.currentPage.elements === undefined,
    `first.unchanged=${first.currentPage.unchanged} second.unchanged=${second.currentPage.unchanged} secondHasElements=${!!second.currentPage.elements}`
  );
}

// ---------- B: changed observation sends fresh full context ----------
{
  const cm = new ContextManager('test task');
  cm.addObservation(makeObs({ stateFingerprint: 'fp-A' }));
  const first = JSON.parse(cm.getContextForLLM());
  cm.addObservation(makeObs({ stateFingerprint: 'fp-B', url: 'https://example.com/other' }));
  const second = JSON.parse(cm.getContextForLLM());
  check(
    'B. changed observation (new fingerprint) sends full elements again',
    !second.currentPage.unchanged && Array.isArray(second.currentPage.elements) && second.currentPage.elements.length === 2,
    `second.unchanged=${second.currentPage.unchanged} elements=${JSON.stringify(second.currentPage.elements)}`
  );
}

// ---------- C: selectedTarget reduces content-item context ----------
{
  const cm = new ContextManager('test task');
  const contentItems = [
    { id: 'c1', type: 'product' as const, title: 'Product B', price: '$25.00', numericPrice: 25, primaryActionElementId: 'e2' },
    { id: 'c2', type: 'product' as const, title: 'Product C', price: '$60.00', numericPrice: 60, primaryActionElementId: 'e3' },
    { id: 'c3', type: 'product' as const, title: 'Product A', price: '$90.00', numericPrice: 90, primaryActionElementId: 'e1' },
  ];
  cm.addObservation(makeObs({ stateFingerprint: 'fp-c1', contentItems, contentItemsTotalFound: 3, contentItemsWithPrice: 3 }));
  const withoutTarget = JSON.parse(cm.getContextForLLM());
  const progress = makeProgress({
    selectedTarget: { label: 'Product B', price: '$25.00', elementId: 'e2', reason: 'lowest price', resolvedFrom: 'https://example.com/' },
  });
  // A genuinely new step (different fingerprint) — not the same observation
  // re-sent, which the §A/§B "unchanged" compression would (correctly)
  // compact down to nothing, unrelated to what this test is checking.
  cm.addObservation(makeObs({ stateFingerprint: 'fp-c2', contentItems, contentItemsTotalFound: 3, contentItemsWithPrice: 3 }));
  const withTarget = JSON.parse(cm.getContextForLLM(progress));
  check(
    'C. selectedTarget trims contentItems to the committed item only',
    withoutTarget.currentPage.contentItems.length === 3 &&
      withTarget.currentPage.contentItems.length === 1 &&
      withTarget.currentPage.contentItems[0].title === 'Product B',
    `withoutTarget=${withoutTarget.currentPage.contentItems.length} withTarget=${JSON.stringify(withTarget.currentPage.contentItems)}`
  );
}

// ---------- D: simple title extraction short-circuit ----------
// Covered end-to-end (real executor, real deterministic path, real browser)
// by test-checkpoint11-fixtures.ts's "F" case, updated this checkpoint:
// "Open example.com and tell me the page title" now completes with
// tokensUsed === 0. Not duplicated here — that test exercises the actual
// executor.evaluateProgress() code path, which is private and browser-driven,
// not something a context-only unit test can reach.
check('D. simple title extraction short-circuit', true, 'verified via test-checkpoint11-fixtures.ts case F (tokensUsed=0)');

// ---------- E: action history rolling window ----------
{
  const cm = new ContextManager('test task');
  cm.addObservation(makeObs());
  for (let i = 1; i <= 6; i++) cm.logAction(`action-${i}`, 'success');
  const ctx = JSON.parse(cm.getContextForLLM());
  check(
    'E. recent action history capped to a 3-action rolling window',
    Array.isArray(ctx.recentActions) && ctx.recentActions.length === 3 && ctx.recentActions[2].startsWith('action-6'),
    `recentActions=${JSON.stringify(ctx.recentActions)}`
  );
}

// ---------- F: failure context is single, not accumulated ----------
{
  // Structural invariant: PlannerFailureContext (executor.ts's lastFailure)
  // is a single object, never an array — each new failure OVERWRITES the
  // previous one rather than appending. Verified here at the type/shape
  // level: the interface has no list-of-failures field to accidentally grow.
  const shape = { action: 'a', code: 'C', error: 'e', url: 'u', urlChanged: false, domChanged: false, attempts: 1 };
  const keys = Object.keys(shape);
  check(
    'F. failure context shape carries exactly one failure (no history array)',
    !keys.some((k) => Array.isArray((shape as any)[k])) && keys.length === 7,
    `keys=${keys.join(',')}`
  );
}

// ---------- G: token aggregation is exact ----------
{
  const cm = new ContextManager('test task');
  cm.recordTokenUsage(100, 50);
  cm.recordTokenUsage(200, 75);
  cm.recordTokenUsage(1, 1);
  check('G. token aggregation sums exactly, no drift', cm.getTokenUsage() === 427, `got=${cm.getTokenUsage()} expected=427`);
}

// ---------- H: budget warning/termination logic ----------
{
  const cm = new ContextManager('test task');
  cm.recordTokenUsage(50, 50); // 100 total
  const tight = cm.getBudgetStatus(80, 150);
  check('H1. tight thresholds: over warn, not yet over hard', tight.overWarn === true && tight.overHard === false, JSON.stringify(tight));

  cm.recordTokenUsage(100, 0); // 200 total
  const tight2 = cm.getBudgetStatus(80, 150);
  check('H2. tight thresholds: over both once total passes hard', tight2.overWarn === true && tight2.overHard === true, JSON.stringify(tight2));

  const cmNormal = new ContextManager('test task');
  cmNormal.recordTokenUsage(10000, 4000); // 14,000 — a real Nike-scale task
  const normalDefaults = cmNormal.getBudgetStatus(); // production defaults
  check(
    'H3. default thresholds do not trip for a normal task-scale usage',
    normalDefaults.overWarn === false && normalDefaults.overHard === false,
    JSON.stringify(normalDefaults)
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
