/**
 * ReadCapability: pure retrieval, no browser.
 *
 * Not a wrapper around Agent Reach (github.com/Panniantong/agent-reach) — we
 * inspected it and deliberately did not take it as a dependency. It targets a
 * different execution model (an LLM coding agent with free shell access
 * choosing which of a dozen third-party CLIs to run), which is incompatible
 * with JARVIS's schema-validated skill model and would be a real safety
 * regression to adopt as-is. What we DID take: the one technique its own
 * `web` channel uses — a plain, zero-key GET to Jina Reader
 * (`https://r.jina.ai/<url>`) — reimplemented natively here, plus a ported
 * version of its public-URL SSRF guard. See the Checkpoint 13 report for the
 * full assessment.
 */

const JINA_READER_PREFIX = 'https://r.jina.ai/';
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15000;
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

export type ReadSource = 'jina' | 'github-readme' | 'github-search' | 'hn-api' | 'wikipedia-api';

export interface RetrievalResult {
  source: ReadSource;
  url: string;
  title?: string;
  text: string;
  metadata?: Record<string, unknown>;
}

export type ReadOutcome =
  | { ok: true; result: RetrievalResult }
  | { ok: false; error: string };

/**
 * Reject anything that is not clearly a public HTTP(S) destination — ported
 * from Agent Reach's `normalize_public_http_url` (agent_reach/utils/url.py).
 * This matters specifically because the read capability's target URL is
 * derived from operator-supplied task text (via classifyGoal's domain
 * match), not a fixed literal — without this, a crafted task could name an
 * internal host (e.g. "localhost:20128", a cloud metadata address) and have
 * JARVIS fetch it as if it were public web content.
 */
const BLOCKED_HOSTS = new Set([
  'localhost',
  'local',
  'localdomain',
  'lan',
  'home.arpa',
  'internal',
  'instance-data',
  'metadata.google.internal',
  'ip6-localhost',
  'ip6-loopback',
]);
const BLOCKED_SUFFIXES = ['.local', '.lan', '.internal', '.localdomain', '.localhost', '.home.arpa'];

function isPrivateOrReservedIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts;
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local + cloud metadata (169.254.169.254)
  if (a === 0) return true; // "this" network
  return false;
}

function isPrivateOrReservedIPv6(host: string): boolean {
  // URL.hostname keeps the brackets for a literal IPv6 address ("[::1]") —
  // strip them before comparing, or every literal silently fails to match.
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === '::1' || h === '::') return true;
  if (h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true; // link-local + ULA
  if (h.startsWith('::ffff:')) return isPrivateOrReservedIPv4(h.slice('::ffff:'.length)); // IPv4-mapped
  return false;
}

export function assertPublicHttpUrl(rawUrl: string): string {
  const candidate = String(rawUrl ?? '').trim();
  if (!candidate || /[\s\x00-\x1f\x7f\\]/.test(candidate)) {
    throw new Error('Only public HTTP(S) URLs are allowed');
  }
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error('Only public HTTP(S) URLs are allowed');
  }
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    !host ||
    parsed.username ||
    parsed.password ||
    BLOCKED_HOSTS.has(host) ||
    BLOCKED_SUFFIXES.some((suf) => host.endsWith(suf)) ||
    isPrivateOrReservedIPv4(host) ||
    isPrivateOrReservedIPv6(host) ||
    (!host.includes('.') && !host.includes(':')) // bare single-label host, not an IP literal
  ) {
    throw new Error('Only public HTTP(S) URLs are allowed');
  }
  return parsed.toString();
}

const ANTIBOT_MARKERS = [
  'just a moment...',
  'performing security verification',
  'attention required! | cloudflare',
];

function looksLikeAntibotChallenge(body: string): boolean {
  const sample = body.slice(0, 4096).toLowerCase();
  if (sample.includes('warning:') && sample.includes('requiring captcha')) return true;
  return ANTIBOT_MARKERS.some((m) => sample.includes(m));
}

async function timedFetch(url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const onExternalAbort = () => controller.abort();
  signal?.addEventListener('abort', onExternalAbort);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onExternalAbort);
  }
}

async function readCapped(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return response.text();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        throw new Error(`Response exceeds ${MAX_RESPONSE_BYTES} byte limit`);
      }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf-8');
}

/** Any public URL, via Jina Reader — the one technique adopted from Agent Reach's `web` channel. */
export async function readWebPage(url: string, signal?: AbortSignal): Promise<ReadOutcome> {
  let publicUrl: string;
  try {
    publicUrl = assertPublicHttpUrl(url);
  } catch (e: any) {
    return { ok: false, error: e.message };
  }

  try {
    const jinaUrl = `${JINA_READER_PREFIX}${publicUrl}`;
    const resp = await timedFetch(jinaUrl, { headers: { 'User-Agent': USER_AGENT, Accept: 'text/plain' } }, signal);
    if (!resp.ok) {
      return { ok: false, error: `Jina Reader returned HTTP ${resp.status}` };
    }
    const body = await readCapped(resp);
    if (!body.trim()) {
      return { ok: false, error: 'Jina Reader returned an empty page' };
    }
    if (looksLikeAntibotChallenge(body)) {
      return { ok: false, error: 'Target page returned an anti-bot/CAPTCHA challenge' };
    }
    const titleMatch = /^Title:\s*(.+)$/m.exec(body);
    return {
      ok: true,
      result: {
        source: 'jina',
        url: publicUrl,
        title: titleMatch?.[1]?.trim(),
        text: body,
      },
    };
  } catch (e: any) {
    if (e?.name === 'AbortError') return { ok: false, error: 'Read cancelled or timed out' };
    return { ok: false, error: e?.message ?? 'Unknown read error' };
  }
}

/**
 * Hacker News top story, via HN's own official public Firebase API — no
 * auth, no rate-limit surprises. Added after live testing found Jina Reader
 * (the generic fallback below) gets network-reputation-blocked from some
 * environments; a platform's own first-party API, where one exists, is more
 * reliable than routing everything through a third-party reader.
 */
export async function readHackerNewsTopStory(signal?: AbortSignal): Promise<ReadOutcome> {
  try {
    const idsResp = await timedFetch('https://hacker-news.firebaseio.com/v0/topstories.json', {}, signal);
    if (!idsResp.ok) return { ok: false, error: `HN topstories API returned HTTP ${idsResp.status}` };
    const ids: unknown = await idsResp.json();
    const topId = Array.isArray(ids) ? ids[0] : undefined;
    if (typeof topId !== 'number') return { ok: false, error: 'HN topstories API returned no stories' };

    const itemResp = await timedFetch(`https://hacker-news.firebaseio.com/v0/item/${topId}.json`, {}, signal);
    if (!itemResp.ok) return { ok: false, error: `HN item API returned HTTP ${itemResp.status}` };
    const item: any = await itemResp.json();
    if (!item?.title) return { ok: false, error: 'HN item API returned no title' };

    const storyUrl = item.url || `https://news.ycombinator.com/item?id=${topId}`;
    return {
      ok: true,
      result: {
        source: 'hn-api',
        url: storyUrl,
        title: item.title,
        text: `${item.title}\n${storyUrl}\nPoints: ${item.score ?? 0} · Comments: ${item.descendants ?? 0}`,
        metadata: { id: topId, score: item.score, descendants: item.descendants },
      },
    };
  } catch (e: any) {
    if (e?.name === 'AbortError') return { ok: false, error: 'Read cancelled or timed out' };
    return { ok: false, error: e?.message ?? 'Unknown read error' };
  }
}

/** Wikipedia article summary, via Wikipedia's own official REST API — no auth, not third-party-gated. */
export async function readWikipediaSummary(title: string, signal?: AbortSignal): Promise<ReadOutcome> {
  try {
    const apiUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
    const resp = await timedFetch(apiUrl, { headers: { Accept: 'application/json' } }, signal);
    if (!resp.ok) {
      return { ok: false, error: `Wikipedia summary API returned HTTP ${resp.status}` };
    }
    const data: any = await resp.json();
    if (!data?.extract) {
      return { ok: false, error: 'Wikipedia summary API returned no extract' };
    }
    return {
      ok: true,
      result: {
        source: 'wikipedia-api',
        url: data.content_urls?.desktop?.page ?? `https://en.wikipedia.org/wiki/${encodeURIComponent(title)}`,
        title: data.title,
        text: data.extract,
      },
    };
  } catch (e: any) {
    if (e?.name === 'AbortError') return { ok: false, error: 'Read cancelled or timed out' };
    return { ok: false, error: e?.message ?? 'Unknown read error' };
  }
}

/** owner/repo README, via GitHub's public REST API — no auth needed for public repos. */
export async function readGitHubReadme(owner: string, repo: string, signal?: AbortSignal): Promise<ReadOutcome> {
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) {
    return { ok: false, error: 'Invalid owner/repo' };
  }
  try {
    const apiUrl = `https://api.github.com/repos/${owner}/${repo}/readme`;
    const resp = await timedFetch(
      apiUrl,
      { headers: { Accept: 'application/vnd.github.raw+json', 'User-Agent': 'jarvis-agent' } },
      signal
    );
    if (!resp.ok) {
      return { ok: false, error: `GitHub README API returned HTTP ${resp.status}` };
    }
    const text = await readCapped(resp);
    if (!text.trim()) {
      return { ok: false, error: 'GitHub returned an empty README' };
    }
    return {
      ok: true,
      result: {
        source: 'github-readme',
        url: `https://github.com/${owner}/${repo}`,
        title: `${owner}/${repo} README`,
        text,
        metadata: { owner, repo },
      },
    };
  } catch (e: any) {
    if (e?.name === 'AbortError') return { ok: false, error: 'Read cancelled or timed out' };
    return { ok: false, error: e?.message ?? 'Unknown read error' };
  }
}

/**
 * Find a public GitHub repo by NAME (not owner/repo) via GitHub's own public
 * search API, then read its README — generic for any project name, not
 * specific to any single repo. Added for Checkpoint 14: "find the React
 * GitHub repository" names a project, not an owner/repo pair, and the
 * browser-planner path was observed (Checkpoint 13 baseline) to hallucinate
 * a wrong repo when asked to guess one. This resolves it deterministically
 * from GitHub's own index instead of an LLM guess.
 */
export async function readGitHubRepoSearch(query: string, signal?: AbortSignal): Promise<ReadOutcome> {
  const q = query.trim();
  if (!q) return { ok: false, error: 'Empty search query' };
  try {
    // `in:name` biases matches toward repos actually NAMED this, not merely
    // repos that mention it somewhere — a plain full-text search sorted by
    // stars surfaced freeCodeCamp/freeCodeCamp for the query "React" (it's
    // enormously starred and its description mentions React), not the
    // actual React project. Verified against GitHub's live search API.
    const searchUrl = `https://api.github.com/search/repositories?q=${encodeURIComponent(`${q} in:name`)}&sort=stars&order=desc&per_page=1`;
    const resp = await timedFetch(searchUrl, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'jarvis-agent' } }, signal);
    if (!resp.ok) return { ok: false, error: `GitHub search API returned HTTP ${resp.status}` };
    const data: any = await resp.json();
    const top = data?.items?.[0];
    if (!top?.full_name) return { ok: false, error: `GitHub search found no repository matching "${q}"` };
    const [owner, repo] = String(top.full_name).split('/');
    if (!owner || !repo) return { ok: false, error: `GitHub search returned an unexpected repo name "${top.full_name}"` };
    const readmeOutcome = await readGitHubReadme(owner, repo, signal);
    if (!readmeOutcome.ok) return readmeOutcome;
    return {
      ok: true,
      result: {
        ...readmeOutcome.result,
        source: 'github-search',
        metadata: { ...readmeOutcome.result.metadata, matchedQuery: q, stars: top.stargazers_count },
      },
    };
  } catch (e: any) {
    if (e?.name === 'AbortError') return { ok: false, error: 'Read cancelled or timed out' };
    return { ok: false, error: e?.message ?? 'Unknown read error' };
  }
}

/** Dispatches a CapabilityDecision-shaped read request to the right backend — shared by task-manager.ts and subgoal-runner.ts so the two never drift. */
export async function resolveRead(
  readSource: ReadSource | undefined,
  readUrl: string | undefined,
  readMeta: { owner?: string; repo?: string; wikipediaTitle?: string; searchQuery?: string } | undefined,
  signal?: AbortSignal
): Promise<ReadOutcome> {
  if (readSource === 'github-readme' && readMeta?.owner && readMeta?.repo) {
    return readGitHubReadme(readMeta.owner, readMeta.repo, signal);
  }
  if (readSource === 'github-search' && readMeta?.searchQuery) {
    return readGitHubRepoSearch(readMeta.searchQuery, signal);
  }
  if (readSource === 'hn-api') {
    return readHackerNewsTopStory(signal);
  }
  if (readSource === 'wikipedia-api' && readMeta?.wikipediaTitle) {
    return readWikipediaSummary(readMeta.wikipediaTitle, signal);
  }
  if (readUrl) {
    return readWebPage(readUrl, signal);
  }
  return { ok: false, error: 'No read target resolved' };
}
