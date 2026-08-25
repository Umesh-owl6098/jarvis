/**
 * Planner model benchmark.
 *
 * Sends the REAL planner system+user prompt shape to each candidate across a
 * fixed scenario set, validates against the REAL PlannerActionSchema, and
 * measures only what the planner needs: a schema-valid action, the RIGHT
 * action, few corrections, small output, low latency.
 *
 * Conversational quality is not measured and must not influence ranking.
 *
 * Env:
 *   BENCH_MODELS   comma list of models            (default: candidate set)
 *   BENCH_TEMP     temperature                     (default 0)
 *   BENCH_MAXTOK   max output tokens               (default 900)
 *   BENCH_NONCE    cache-buster; set it per run    (recommended)
 *   BENCH_REPEATS  repeats per scenario            (default 1)
 */

import { SkillRegistry } from '@/skills/registry';
import { NavigationSkill } from '@/skills/navigation';
import { ExtractionSkill } from '@/skills/extraction';
import { InteractionSkill } from '@/skills/interaction';
import { SearchSkill } from '@/skills/search';
import { BrowserController } from '@/core/browser/controller';
import { PlannerActionSchema } from '@/core/agent/planner';

const BASE = process.env.OMNIROUTE_BASE_URL || 'http://localhost:20128';
const TEMP = Number(process.env.BENCH_TEMP ?? 0);
const MAXTOK = Number(process.env.BENCH_MAXTOK ?? 900);
const NONCE = process.env.BENCH_NONCE || '';
const REPEATS = Number(process.env.BENCH_REPEATS ?? 1);

const CANDIDATES = (
  process.env.BENCH_MODELS || ['auto', 'oc/hy3-free', 'oc/nemotron-3-ultra-free'].join(',')
)
  .split(',')
  .map((m) => m.trim())
  .filter(Boolean);

/**
 * Scenario + the action(s) a competent planner should choose.
 * Several states admit more than one defensible move, so `accept` is a set.
 */
interface Scenario {
  name: string;
  task: string;
  page: unknown;
  recent: unknown[];
  /** 'finish' | 'fail' | skill id */
  accept: string[];
}

function heavyElements(n: number) {
  const roles = ['link', 'button', 'textbox', 'checkbox'];
  return Array.from({ length: n }, (_, i) => ({
    id: `e${i + 1}`,
    role: roles[i % roles.length],
    name: `Nav item ${i + 1} — department listing and promotions`,
    ...(i % 7 === 0 ? { placeholder: 'Search products' } : {}),
  }));
}

const SCENARIOS: Scenario[] = [
  { name: '01 open wikipedia', task: 'Open wikipedia.org', page: null, recent: [], accept: ['navigation'] },
  { name: '02 open github', task: 'Open github.com', page: null, recent: [], accept: ['navigation'] },
  {
    name: '03 search wikipedia',
    task: 'Search Wikipedia for OpenAI',
    page: { url: 'https://www.wikipedia.org/', title: 'Wikipedia', textPreview: 'Wikipedia The Free Encyclopedia', elements: [{ id: 'e1', role: 'searchbox', name: 'Search Wikipedia' }, { id: 'e2', role: 'button', name: 'Search' }] },
    recent: ['navigation success'],
    accept: ['search', 'interaction'],
  },
  {
    name: '04 search github',
    task: 'Search GitHub for React repositories',
    page: { url: 'https://github.com/', title: 'GitHub', textPreview: 'Build and ship software', elements: [{ id: 'e1', role: 'button', name: 'Search or jump to' }, { id: 'e2', role: 'link', name: 'Pricing' }] },
    recent: ['navigation success'],
    accept: ['search', 'interaction'],
  },
  {
    name: '05 title after nav',
    task: 'Open wikipedia.org and tell me the page title',
    page: { url: 'https://www.wikipedia.org/', title: 'Wikipedia', textPreview: 'Wikipedia', elements: [{ id: 'e1', role: 'searchbox', name: 'Search' }] },
    recent: ['navigation success'],
    accept: ['extraction', 'finish'],
  },
  {
    name: '06 click element e2',
    task: 'Click the Pricing link',
    page: { url: 'https://github.com/', title: 'GitHub', textPreview: 'Build', elements: [{ id: 'e1', role: 'button', name: 'Search' }, { id: 'e2', role: 'link', name: 'Pricing' }] },
    recent: ['navigation success'],
    accept: ['interaction'],
  },
  {
    name: '07 extract text',
    task: 'Tell me what this page says',
    page: { url: 'https://example.com/', title: 'Example Domain', textPreview: 'This domain is for use in illustrative examples', elements: [{ id: 'e1', role: 'link', name: 'More information' }] },
    recent: ['navigation success'],
    accept: ['extraction', 'finish'],
  },
  {
    name: '08 finish when done',
    task: 'Open example.com and tell me the page title',
    page: { url: 'https://example.com/', title: 'Example Domain', textPreview: 'Example', elements: [] },
    recent: ['navigation success', 'extraction success: title="Example Domain"'],
    accept: ['finish'],
  },
  {
    name: '09 recover element-not-found',
    task: 'Search Wikipedia for OpenAI',
    page: { url: 'https://www.wikipedia.org/', title: 'Wikipedia', textPreview: 'Wikipedia', elements: [{ id: 'e1', role: 'searchbox', name: 'Search Wikipedia' }] },
    recent: ['interaction failed: [ELEMENT_NOT_FOUND] Element e7 is no longer on the page'],
    accept: ['search', 'interaction'],
  },
  {
    name: '10 avoid repeating',
    task: 'Open wikipedia.org',
    page: { url: 'https://www.wikipedia.org/', title: 'Wikipedia', textPreview: 'Wikipedia', elements: [] },
    recent: ['navigation success', 'navigation success'],
    accept: ['finish'],
  },
  {
    name: '11 heavy amazon storefront',
    task: 'Search Amazon for Sony headphones',
    page: { url: 'https://www.amazon.com/', title: 'Amazon.com. Spend less. Smile more.', textPreview: 'Skip to Main content Keyboard shortcuts Search Cart Home Orders Delivering to Irving 75039 All Departments Alexa Skills Amazon Devices Amazon Fresh Amazon Pharmacy Appliances Apps & Games Arts Crafts & Sewing Automotive Baby Beauty & Personal Care Books CDs & Vinyl Cell Phones', elements: heavyElements(43) },
    recent: ['navigation success'],
    accept: ['search', 'interaction'],
  },
  {
    name: '12 heavy github results',
    task: 'Search GitHub for React repositories',
    page: { url: 'https://github.com/search?q=React&type=repositories', title: 'Repository search results · GitHub', textPreview: 'facebook/react The library for web and native user interfaces JavaScript 220k stars Updated 2 hours ago typescript-cheatsheets/react Cheatsheets for experienced React developers', elements: heavyElements(57) },
    recent: ['navigation success', 'search success: query="React"'],
    accept: ['finish', 'extraction'],
  },
  {
    name: '13 heavy wikipedia article',
    task: 'Open wikipedia.org and search for OpenAI',
    page: { url: 'https://en.wikipedia.org/wiki/OpenAI', title: 'OpenAI - Wikipedia', textPreview: 'OpenAI is an American artificial intelligence organization headquartered in San Francisco California.', elements: heavyElements(52) },
    recent: ['navigation success', 'search success: query="OpenAI"'],
    accept: ['finish', 'extraction'],
  },
];

/** Prose that leaked into `content` instead of a structured field. */
const LEAK = /^(?:\s*)(?:the user|we need|okay|let me|first[,:]|i need to|thinking|analysis|sure[,!]|here'?s)/i;
/** Provider capacity/availability failures, kept separate from model quality. */
const PROVIDER_FAIL = /\b(429|rate limit|unavailable|not found|blocked|502|503|504|empty response)\b/i;

interface Stat {
  model: string;
  cases: number;
  valid: number;
  correct: number;
  leaks: number;
  malformed: number;
  truncated: number;
  corrections: number;
  correctedOk: number;
  providerFails: number;
  otherErrors: number;
  finishReasons: Record<string, number>;
  inTok: number[];
  outTok: number[];
  latency: number[];
  actionBytes: number[];
  served: Set<string>;
  samples: string[];
}

function buildPrompts(skillsList: string, s: Scenario, correction: boolean) {
  const system = `You are an autonomous web agent. Your goal is to accomplish tasks by browsing and interacting with web pages.

Available skills:
${skillsList}

CRITICAL RULES:
0. Keep "reasoning" under 12 words.
1. Respond ONLY with valid JSON matching the schema below
2. No prose, no markdown fences, no explanation outside the JSON
3. Schema: {"action":"use_skill","skillId":"<id>","input":{...},"reasoning":"<short>"}
   or {"action":"finish","result":"<answer>"} or {"action":"fail","reason":"<why>"}
4. If the task names a domain, navigate to THAT domain
5. Finish as soon as the task is satisfied`;

  const user = `Current state:
${JSON.stringify({ task: s.task, currentPage: s.page, recentActions: s.recent, failureCount: 0 })}

${correction ? 'Your previous response was invalid JSON. Please respond ONLY with a single valid JSON object.' : 'What should I do next?'}

Respond ONLY with valid JSON. No other text.${NONCE ? `\n(run ${NONCE}-${s.name})` : ''}`;
  return { system, user };
}

/** Balanced-brace extraction, as the planner does defensively. */
function extractJson(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    /* continue */
  }
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function chosenAction(parsed: any): string | null {
  if (!parsed || typeof parsed !== 'object') return null;
  if (parsed.action === 'finish') return 'finish';
  if (parsed.action === 'fail') return 'fail';
  if (parsed.action === 'use_skill') return String(parsed.skillId ?? '');
  return null;
}

async function call(model: string, system: string, user: string) {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      temperature: TEMP,
      max_tokens: MAXTOK,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
    signal: AbortSignal.timeout(120000),
  });
  const latency = Date.now() - t0;
  const body: any = await res.json().catch(() => ({}));
  return {
    latency,
    served: String(body?.model ?? ''),
    content: String(body?.choices?.[0]?.message?.content ?? ''),
    finish: String(body?.choices?.[0]?.finish_reason ?? 'none'),
    inTok: Number(body?.usage?.prompt_tokens ?? 0),
    outTok: Number(body?.usage?.completion_tokens ?? 0),
    error: (body?.error?.message as string | undefined) ?? undefined,
  };
}

const avg = (a: number[]) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : 0);
const pct = (n: number, d: number) => (d ? Math.round((n / d) * 100) : 0);
const quantile = (a: number[], q: number) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(s.length * q))];
};

async function main() {
  const browser = new BrowserController();
  const reg = new SkillRegistry();
  reg.register(new NavigationSkill(browser));
  reg.register(new ExtractionSkill(browser));
  reg.register(new InteractionSkill(browser));
  reg.register(new SearchSkill(browser));
  const skillsList = reg.getSkillsPrompt();

  console.log(`config: temp=${TEMP} max_tokens=${MAXTOK} repeats=${REPEATS} nonce=${NONCE || '(none)'}\n`);

  const stats: Stat[] = [];

  for (const model of CANDIDATES) {
    const st: Stat = {
      model, cases: 0, valid: 0, correct: 0, leaks: 0, malformed: 0, truncated: 0,
      corrections: 0, correctedOk: 0, providerFails: 0, otherErrors: 0,
      finishReasons: {}, inTok: [], outTok: [], latency: [], actionBytes: [],
      served: new Set(), samples: [],
    };

    for (let rep = 0; rep < REPEATS; rep++) {
      for (const s of SCENARIOS) {
        st.cases++;
        try {
          const { system, user } = buildPrompts(skillsList, s, false);
          const out = await call(model, system, user);

          if (out.error) {
            if (PROVIDER_FAIL.test(out.error)) st.providerFails++;
            else st.otherErrors++;
            if (st.samples.length < 3) st.samples.push(`[err] ${out.error.slice(0, 100)}`);
            continue;
          }

          st.served.add(out.served);
          st.latency.push(out.latency);
          st.inTok.push(out.inTok);
          st.outTok.push(out.outTok);
          st.finishReasons[out.finish] = (st.finishReasons[out.finish] ?? 0) + 1;
          if (out.finish === 'length') st.truncated++;
          if (LEAK.test(out.content)) st.leaks++;

          let parsed = extractJson(out.content);
          let ok = parsed !== null && PlannerActionSchema.safeParse(parsed).success;

          if (!ok) {
            st.malformed++;
            if (st.samples.length < 3) st.samples.push(`[bad] ${out.content.replace(/\s+/g, ' ').slice(0, 100)}`);
            // The planner allows exactly one correction retry — measure it.
            st.corrections++;
            const retry = buildPrompts(skillsList, s, true);
            const out2 = await call(model, retry.system, retry.user);
            if (!out2.error) {
              st.latency.push(out2.latency);
              st.inTok.push(out2.inTok);
              st.outTok.push(out2.outTok);
              st.finishReasons[out2.finish] = (st.finishReasons[out2.finish] ?? 0) + 1;
              parsed = extractJson(out2.content);
              ok = parsed !== null && PlannerActionSchema.safeParse(parsed).success;
              if (ok) st.correctedOk++;
            }
          }

          if (ok) {
            st.valid++;
            st.actionBytes.push(JSON.stringify(parsed).length);
            const act = chosenAction(parsed);
            if (act && s.accept.includes(act)) st.correct++;
            else if (st.samples.length < 3) st.samples.push(`[wrong action] ${s.name}: chose "${act}", expected ${s.accept.join('|')}`);
          }
        } catch (e) {
          const msg = String((e as Error).message);
          if (PROVIDER_FAIL.test(msg)) st.providerFails++;
          else st.otherErrors++;
          if (st.samples.length < 3) st.samples.push(`[throw] ${msg.slice(0, 100)}`);
        }
      }
    }

    stats.push(st);
    console.log(
      `${st.model.padEnd(26)} valid ${st.valid}/${st.cases} (${pct(st.valid, st.cases)}%)  ` +
        `correct ${st.correct}/${st.cases} (${pct(st.correct, st.cases)}%)  ` +
        `malformed ${st.malformed}  trunc ${st.truncated}  leak ${st.leaks}  ` +
        `corr ${st.corrections}(+${st.correctedOk} recovered)  429/prov ${st.providerFails}`
    );
    if (st.served.size) console.log(`${' '.repeat(26)} served: ${[...st.served].join(', ')}`);
    for (const s of st.samples) console.log(`${' '.repeat(26)} ${s}`);
  }

  console.log('\n=== FULL MATRIX ===');
  console.log(
    'model                      cases valid  valid%  correct%  malf trunc leak corr  avgIn avgOut  avgLat   429  finish_reasons'
  );
  for (const s of stats) {
    const fr = Object.entries(s.finishReasons).map(([k, v]) => `${k}:${v}`).join(' ') || '—';
    console.log(
      `${s.model.padEnd(26)} ${String(s.cases).padStart(5)} ${String(s.valid).padStart(5)} ` +
        `${String(pct(s.valid, s.cases) + '%').padStart(7)} ${String(pct(s.correct, s.cases) + '%').padStart(9)} ` +
        `${String(s.malformed).padStart(5)} ${String(s.truncated).padStart(5)} ${String(s.leaks).padStart(4)} ` +
        `${String(s.corrections).padStart(4)} ${String(avg(s.inTok)).padStart(6)} ${String(avg(s.outTok)).padStart(6)} ` +
        `${String(avg(s.latency) + 'ms').padStart(8)} ${String(s.providerFails).padStart(5)}  ${fr}`
    );
  }

  console.log('\n=== OBSERVED AgentAction SIZES (drives a safe max_tokens) ===');
  for (const s of stats) {
    if (!s.actionBytes.length) continue;
    console.log(
      `${s.model.padEnd(26)} action JSON bytes  min ${quantile(s.actionBytes, 0)}  median ${quantile(s.actionBytes, 0.5)}  ` +
        `p90 ${quantile(s.actionBytes, 0.9)}  max ${quantile(s.actionBytes, 1)}   | completion tokens: median ${quantile(s.outTok, 0.5)} p90 ${quantile(s.outTok, 0.9)} max ${quantile(s.outTok, 1)}`
    );
  }

  await browser.close().catch(() => {});
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
