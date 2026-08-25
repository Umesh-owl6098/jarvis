/**
 * Checkpoint 15 — GoalAnalysis: deterministic structural understanding of a
 * task, computed BEFORE classifyGoal() trusts any of its own single-goal
 * patterns.
 *
 * Root problem this fixes: classifyGoal() has several independent regex
 * branches (a bare-domain check, an "open the <noun>" target-phrase check,
 * a "domain + trailing tell-me clause" extract check), and a compound
 * sentence can trip ANY of them individually — the domain/filename mention
 * or a trailing "and tell me X" clause overrides the fact that real
 * dependent work (search, then open, then extract) sits in between. Patching
 * each pattern one at a time is exactly the "increasingly fragile giant
 * regex" the checkpoint warned against. Instead: decide compound-vs-simple
 * ONCE, generically, independent of which pattern would have matched, and
 * gate classifyGoal's entire single-goal branch set behind it.
 *
 * No LLM call — purely deterministic, reusing subgoal.ts's own clause
 * splitting so the two modules never disagree about what a "clause" is.
 */

import { splitClauses } from './subgoal';
import { REFERENCE_PHRASE_RE } from './target-state';

export interface GoalAnalysis {
  originalGoal: string;
  objectiveCount: number;
  hasDependencies: boolean;
  explicitHosts: string[];
  explicitUrls: string[];
  fileLikeTokens: string[];
  actionVerbs: string[];
  requiresPlan: boolean;
}

/**
 * Extensions that make a dotted token a FILE, not a domain — curated
 * blocklist rather than a TLD allowlist, because real TLDs (.dev, .app,
 * .io, .ai, .co...) are numerous, growing, and often the same length/shape
 * as common file extensions. A file extension is a much smaller, far more
 * stable set to enumerate correctly.
 */
const FILE_EXTENSIONS = new Set([
  'md', 'markdown', 'txt', 'rtf', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'csv',
  'html', 'htm', 'xml', 'json', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env', 'lock',
  'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'py', 'rb', 'go', 'java', 'kt', 'c', 'cpp', 'h', 'hpp',
  'cs', 'php', 'sh', 'bash', 'zsh', 'ps1', 'sql', 'db', 'sqlite', 'css', 'scss', 'less', 'log',
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp', 'tiff', 'heic',
  'mp3', 'mp4', 'wav', 'avi', 'mov', 'mkv', 'flac', 'ogg', 'webm',
  'zip', 'tar', 'gz', 'rar', '7z', 'bz2', 'dmg', 'exe', 'apk', 'deb', 'rpm',
]);

/** A plausible TLD is 2-24 ascii letters — real TLDs range up to ~24 chars (e.g. "xn--" punycode aside). Deliberately generous; the file-extension blocklist above is what actually does the discriminating work. */
const PLAUSIBLE_TLD_RE = /^[a-z]{2,24}$/;

/**
 * Is this dotted token's final segment a known file extension, not a
 * plausible TLD? Exported so classifyGoal (goal-state.ts) can gate its own
 * domain match against the SAME blocklist instead of trusting a bare regex
 * shape — "report.md" and "fixture.html" LOOK like a domain to a naive
 * dotted-token pattern, but are never one.
 */
export function isFileLikeToken(token: string): boolean {
  const lastSeg = token.split('.').pop()?.toLowerCase() ?? '';
  return FILE_EXTENSIONS.has(lastSeg);
}

const SCHEME_URL_RE = /\bhttps?:\/\/[^\s'"<>]+/gi;
const DOTTED_TOKEN_RE = /\b[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+\b/gi;

function extractHostsUrlsAndFiles(text: string): { urls: string[]; hosts: string[]; fileLikeTokens: string[] } {
  const urls = new Set<string>();
  const hosts = new Set<string>();
  const fileLikeTokens = new Set<string>();
  const consumed = new Set<string>();

  let m: RegExpExecArray | null;
  SCHEME_URL_RE.lastIndex = 0;
  while ((m = SCHEME_URL_RE.exec(text))) {
    try {
      const u = new URL(m[0].replace(/[.,;:!?)]+$/, ''));
      urls.add(u.toString());
      hosts.add(u.hostname.toLowerCase());
      consumed.add(m[0]);
    } catch {
      // not a valid URL despite the scheme prefix — ignore
    }
  }

  DOTTED_TOKEN_RE.lastIndex = 0;
  while ((m = DOTTED_TOKEN_RE.exec(text))) {
    const token = m[0];
    if ([...consumed].some((c) => c.includes(token))) continue;
    const lastSeg = token.split('.').pop()!.toLowerCase();
    if (FILE_EXTENSIONS.has(lastSeg)) {
      fileLikeTokens.add(token);
      continue;
    }
    if (PLAUSIBLE_TLD_RE.test(lastSeg)) {
      try {
        const u = new URL(`https://${token}`);
        hosts.add(u.hostname.toLowerCase());
      } catch {
        // malformed despite looking dotted — not a usable host
      }
    }
  }

  return { urls: [...urls], hosts: [...hosts], fileLikeTokens: [...fileLikeTokens] };
}

const ACTION_VERB_RE = /\b(open|go to|navigate to|visit|reach|search|find|select|choose|pick|identify|click|read|extract|tell me|report|what is|what does|inspect|summarize|compare)\b/gi;

/**
 * A later clause referring back to an earlier one's result — "the result",
 * "it", "the article", "that one", "the selected item", "the repository",
 * "the product", "the same page" — with no NEW destination of its own names
 * a real data dependency, not an independent objective. Reuses
 * target-state.ts's own reference vocabulary (§12) so this module and the
 * reference resolver can never disagree about what counts as a referent.
 */
const DEPENDENCY_REFERENT_RE = REFERENCE_PHRASE_RE;

export function analyzeGoal(task: string): GoalAnalysis {
  const originalGoal = task.trim();
  const { urls, hosts, fileLikeTokens } = extractHostsUrlsAndFiles(originalGoal);

  const actionVerbs = [...new Set((originalGoal.match(ACTION_VERB_RE) ?? []).map((v) => v.toLowerCase()))];

  const clauses = splitClauses(originalGoal);
  // ACTION_VERB_RE carries the /g flag, which makes .test() STATEFUL — calling
  // it on clause N leaves lastIndex pointing partway into that string, and if
  // clause N+1 is shorter, .test() returns a false negative before it even
  // looks at the content (lastIndex > string length). Reset before EVERY call,
  // not once after the loop — resetting only afterward is too late to prevent
  // the false negatives during the loop itself.
  const clausesWithVerbs = clauses.filter((c) => {
    ACTION_VERB_RE.lastIndex = 0;
    return ACTION_VERB_RE.test(c);
  });
  ACTION_VERB_RE.lastIndex = 0;
  const objectiveCount = Math.max(1, clausesWithVerbs.length);

  const hasDependencies = clauses.some((c) => DEPENDENCY_REFERENT_RE.test(c));

  // Compound iff there is real multi-clause structure — either genuinely
  // dependent (a later clause consumes an earlier one's result) or simply
  // several distinct action clauses chained together. A single clause that
  // merely mentions a host/file/URL is never compound on its own — "Open
  // wikipedia.org" stays simple; "Open wikipedia.org, search for X, open
  // the result" is not, regardless of how classifyGoal's own regexes would
  // read the string in isolation.
  const requiresPlan = objectiveCount >= 2 && (hasDependencies || clausesWithVerbs.length >= 3);

  return {
    originalGoal,
    objectiveCount,
    hasDependencies,
    explicitHosts: hosts,
    explicitUrls: urls,
    fileLikeTokens,
    actionVerbs,
    requiresPlan,
  };
}
