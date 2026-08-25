import { normalizeUrl } from '@/core/browser/url';

/**
 * Deterministic first-navigation bootstrap.
 *
 * When a task explicitly names ONE destination and the browser is still on a
 * blank page, there is nothing for a language model to decide: normalise the
 * domain and go. This saves a planner round-trip and — more importantly —
 * keeps "Open amazon.com" working while the router is rate limited or the
 * model is producing poor output.
 *
 * Scope is intentionally tiny. This is NOT a task parser:
 *  - it only ever produces the FIRST navigation
 *  - it refuses when the task names zero or several distinct destinations
 *  - everything after the navigation is the planner's job
 *
 * "Open wikipedia.org and search for OpenAI" bootstraps the navigation and
 * then hands the remaining work to the planner.
 */

export interface BootstrapDecision {
  url: string;
  domain: string;
  /** Why the bootstrap did or did not fire — surfaced in logs/telemetry. */
  reason: string;
}

/** Matches a bare or absolute domain. Deliberately strict about the TLD. */
const DOMAIN_RE =
  /\b((?:https?:\/\/)?(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?:\/[^\s'"]*)?)/gi;

/**
 * File-ish endings that look like domains but are almost never destinations
 * ("report.md", "index.js", "photo.png").
 */
const NOT_A_SITE = /\.(md|js|ts|tsx|jsx|json|txt|png|jpe?g|gif|svg|css|html?|pdf|zip|csv|yml|yaml)$/i;

/** Verbs that indicate the user is asking to go somewhere. */
const NAVIGATION_INTENT = /\b(open|go to|goto|navigate to|visit|browse to|load|launch)\b/i;

export function planBootstrapNavigation(
  task: string,
  currentUrl: string
): BootstrapDecision | null {
  // Only ever the first move. Once a real page is loaded, the planner owns it.
  if (currentUrl && currentUrl !== 'about:blank' && !currentUrl.startsWith('chrome://')) {
    return null;
  }

  const raw = String(task ?? '');
  console.log(`[integrity] bootstrap.task=${JSON.stringify(raw)} len=${raw.length}`);
  const matches = Array.from(raw.matchAll(DOMAIN_RE))
    .map((m) => m[1])
    .filter((d) => !NOT_A_SITE.test(d.replace(/\/.*$/, '')));

  if (matches.length === 0) return null;

  // Several *different* hosts means the intent is ambiguous — let the planner decide.
  const hosts = new Set(
    matches.map((d) => {
      try {
        return normalizeUrl(d).url.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].toLowerCase();
      } catch {
        return d.toLowerCase();
      }
    })
  );
  if (hosts.size > 1) return null;

  // A bare domain typed on its own IS the command ("amazon.com"). Accept it,
  // but only when the whole task is that domain and nothing else — anything
  // with surrounding prose still needs an explicit navigation verb.
  const bareDomainOnly = raw.trim() === matches[0].trim();

  // Otherwise require explicit navigation intent, so a task that merely
  // mentions a domain ("compare amazon.com pricing models") does not jump.
  if (!bareDomainOnly && !NAVIGATION_INTENT.test(raw)) return null;

  try {
    const { url } = normalizeUrl(matches[0]);
    return {
      url,
      domain: [...hosts][0],
      reason: bareDomainOnly
        ? 'bare domain typed as the whole command'
        : 'explicit single destination on a blank page',
    };
  } catch {
    return null;
  }
}
