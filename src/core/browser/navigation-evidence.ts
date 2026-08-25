/**
 * Checkpoint 16 — NavigationEvidence: structured, honest evidence about what
 * actually happened during a navigation, as distinct from whether Playwright
 * merely completed the goto() call without throwing.
 *
 * Every field here is something the browser can actually observe — no
 * invented signals. Error-page detection is deliberately evidence-only
 * (HTTP status + browser navigation exceptions), NOT page-text heuristics:
 * a page whose body happens to contain the word "error" with a real HTTP
 * 200 is not an error page, and building a site-specific or keyword-based
 * detector was explicitly out of scope (§5).
 */

export interface NavigationEvidence {
  requestedUrl: string;
  finalUrl: string;
  /** Undefined only when the browser never got a response at all (connection failure, DNS failure, timeout). */
  httpStatus?: number;
  pageTitle: string;
  /** Same registrable host (ignoring www./scheme) as the ORIGINAL request — true even across a redirect to a different path. */
  reachedRequestedOrigin: boolean;
  /** Final URL differs from the requested one — could be a normal canonical redirect or a redirect to something else entirely; see reachedRequestedOrigin/errorPageDetected for which. */
  redirected: boolean;
  /**
   * Evidence-based, not text-based: true when there was no HTTP response at
   * all (connection/DNS failure — see browserError) OR the main-document
   * response status was >= 400. A 3xx that Playwright already followed to a
   * 2xx is NOT an error — that is exactly what `redirected` is for.
   */
  errorPageDetected: boolean;
  /** Set only when the browser itself failed to get any response (net::ERR_*, timeout, DNS failure). */
  browserError?: string;
  timestamp: number;
}

function registrableHost(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Build NavigationEvidence from what the browser layer actually observed.
 * `httpStatus` should be the FINAL response's status (Playwright's
 * page.goto() already follows redirects and returns the last response), or
 * undefined if goto() threw before any response arrived.
 */
export function buildNavigationEvidence(params: {
  requestedUrl: string;
  finalUrl: string;
  httpStatus?: number;
  pageTitle: string;
  browserError?: string;
}): NavigationEvidence {
  const { requestedUrl, finalUrl, httpStatus, pageTitle, browserError } = params;
  const requestedHost = registrableHost(requestedUrl);
  const finalHost = registrableHost(finalUrl);
  const reachedRequestedOrigin = requestedHost !== null && requestedHost === finalHost;

  return {
    requestedUrl,
    finalUrl,
    httpStatus,
    pageTitle,
    reachedRequestedOrigin,
    redirected: requestedUrl !== finalUrl,
    errorPageDetected: browserError !== undefined || (httpStatus !== undefined && httpStatus >= 400),
    browserError,
    timestamp: Date.now(),
  };
}
