/**
 * Typed-command matrix with server-side correlation.
 *
 * Each command is typed into the real UI and submitted exactly as an operator
 * would. UI state is read from the rendered HUD; bootstrap/planner behaviour is
 * correlated from the dev-server log by task id, so "planner called" and the
 * action sequence are observed facts rather than inferences.
 *
 * Usage: tsx src/scripts/test-command-matrix.ts /path/to/dev-server.log
 */

import { chromium, type Page } from 'playwright';
import { readFileSync } from 'node:fs';

const BASE = 'http://localhost:3000?skipIntro=1';
const LOG = process.argv[2] || '/tmp/t2-jarvis.log';

const COMMANDS = [
  'amazon.com',
  'Open amazon.com',
  'Open wikipedia.org',
  'Open github.com',
  'Open example.com',
  'Open wikipedia.org and search for OpenAI',
  'Search GitHub for React repositories',
];

interface Row {
  typed: string;
  directive: string | null;
  taskId: string | null;
  phase: string | null;
  url: string | null;
  title: string | null;
  result: string | null;
  bootstrap: string | null;
  plannerCalls: number;
  actions: string[];
  navUrl: string | null;
  integrity: Record<string, string>;
}

const field = (p: Page, src: string) =>
  p.evaluate((s) => {
    const m = document.body.innerText.match(new RegExp(s, 'm'));
    return m ? m[1].trim() : null;
  }, src);

/** Slice the dev log for one task and pull out observed behaviour. */
function correlate(taskId: string | null, typed: string) {
  const log = readFileSync(LOG, 'utf8');
  const out = {
    bootstrap: null as string | null,
    plannerCalls: 0,
    actions: [] as string[],
    navUrl: null as string | null,
    integrity: {} as Record<string, string>,
  };
  if (!taskId) return out;

  // Anchor on this task's OWN execution banner. Anchoring on the first mention
  // of the id lands on the earlier `[stream]` line, and the "next banner" is
  // then the task's own — which slices the entire body away.
  const banner = `🤖 Starting JARVIS execution (${taskId})`;
  const start = log.indexOf(banner);
  if (start === -1) return out;
  const rest = log.slice(start + banner.length);
  const nextBanner = rest.indexOf('🤖 Starting JARVIS execution');
  const section = nextBanner === -1 ? rest : rest.slice(0, nextBanner);

  const boot = section.match(/🚀 BOOTSTRAP: (\S+) \(([^)]+)\)/);
  if (boot) {
    out.bootstrap = `${boot[1]} (${boot[2]})`;
    out.navUrl = boot[1];
  }

  out.plannerCalls = (section.match(/\[Planner\] Attempt \d+: Asking LLM/g) || []).length;
  out.actions = [...section.matchAll(/\[Planner\] Action: ([^\n]+)/g)].map((m) => m[1].trim());

  // Integrity hops are logged just before the banner, so search the wider window.
  const window = log.slice(Math.max(0, start - 4000), start + 4000);
  for (const key of ['SSEBody.task', 'runTask.task', 'executor.task', 'bootstrap.task', 'planner.task']) {
    const re = new RegExp(`\\[integrity\\] ${key.replace('.', '\\.')}=("(?:[^"\\\\]|\\\\.)*")`, 'g');
    const hits = [...window.matchAll(re)].map((m) => JSON.parse(m[1]));
    const hit = hits.find((h) => h === typed);
    if (hit !== undefined) out.integrity[key] = hit;
    else if (hits.length) out.integrity[key] = `MISMATCH: ${JSON.stringify(hits[hits.length - 1])}`;
  }
  return out;
}

async function runOne(page: Page, typed: string): Promise<Row> {
  // Wait until the box is enabled (previous task fully finished), then reset.
  await page.waitForFunction(
    () => {
      const t = document.getElementById('jarvis-command') as HTMLTextAreaElement | null;
      return !!t && !t.disabled;
    },
    { timeout: 300000 }
  );
  const reset = page.locator('button', { hasText: 'Reset' }).first();
  if (await reset.count()) await reset.click().catch(() => {});
  await page.waitForTimeout(500);

  await page.fill('#jarvis-command', typed);
  await page.waitForTimeout(200);
  await page.locator('button', { hasText: 'Execute' }).first().click();

  const phase = await page
    .waitForFunction(
      () => {
        const m = document.body.innerText.match(/PHASE\n([^\n]+)/);
        const v = m ? m[1].trim() : '';
        return ['COMPLETED', 'FAILED', 'STOPPED'].includes(v) ? v : false;
      },
      { timeout: 300000 }
    )
    .then((h) => h.jsonValue() as Promise<string>)
    .catch(() => null);

  await page.waitForTimeout(700);

  const taskId = await field(page, 'TASK ID\\n([^\\n]+)');
  const c = correlate(taskId, typed);

  return {
    typed,
    directive: await field(page, 'DIRECTIVE\\n([^\\n]+)'),
    taskId,
    phase,
    url: await field(page, '\\nURL\\n([^\\n]+)'),
    title: await field(page, 'DOCUMENT TITLE\\n([^\\n]+)'),
    result:
      (await field(page, 'RETURNED PAYLOAD\\n+([^\\n]+)')) ??
      (await field(page, 'FAULT REPORT\\n+([^\\n]+)')),
    ...c,
  };
}

async function main() {
  const browser = await chromium.launch({ channel: 'chrome' });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);

  const rows: Row[] = [];
  for (let i = 0; i < COMMANDS.length; i++) {
    const row = await runOne(page, COMMANDS[i]);
    rows.push(row);
    const pass = row.phase === 'COMPLETED' && row.directive === row.typed;
    console.log(`\n${'='.repeat(72)}\n${i + 1}. ${JSON.stringify(row.typed)}   ${pass ? '✅ PASS' : '❌ FAIL'}`);
    console.log(`   directive      : ${JSON.stringify(row.directive)}`);
    console.log(`   directive==typed: ${row.directive === row.typed}`);
    console.log(`   taskId         : ${row.taskId}`);
    console.log(`   bootstrap      : ${row.bootstrap ?? 'NO'}`);
    console.log(`   planner called : ${row.plannerCalls > 0 ? `YES (${row.plannerCalls} calls)` : 'NO'}`);
    console.log(`   action seq     : ${row.actions.length ? row.actions.join(' → ') : '(none)'}`);
    console.log(`   navigation URL : ${row.navUrl ?? '(planner-driven)'}`);
    console.log(`   final URL      : ${row.url}`);
    console.log(`   title          : ${row.title}`);
    console.log(`   phase          : ${row.phase}`);
    console.log(`   result         : ${String(row.result).slice(0, 130)}`);
  }

  console.log(`\n${'='.repeat(72)}\nDIRECTIVE INTEGRITY (must equal typed input exactly)`);
  let bad = 0;
  for (const r of rows) {
    const ok = r.directive === r.typed;
    if (!ok) bad++;
    console.log(`${ok ? '✅' : '❌'} ${JSON.stringify(r.typed)} -> ${JSON.stringify(r.directive)}`);
  }

  const wiki = rows.find((r) => r.typed === 'Open wikipedia.org');
  if (wiki) {
    console.log(`\nCOMMAND INTEGRITY TRACE — "Open wikipedia.org"`);
    console.log(`   inputValue    = ${JSON.stringify(wiki.typed)}`);
    console.log(`   submittedTask = ${JSON.stringify(wiki.directive)}`);
    for (const [k, v] of Object.entries(wiki.integrity)) {
      console.log(`   ${k.padEnd(13)} = ${JSON.stringify(v)}`);
    }
  }

  const passed = rows.filter((r) => r.phase === 'COMPLETED' && r.directive === r.typed).length;
  console.log(`\n${passed}/${rows.length} commands PASS · ${rows.length - bad}/${rows.length} directives exact`);

  await browser.close();
  if (bad > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
