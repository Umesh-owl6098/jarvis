/**
 * Structured browser/agent error codes.
 *
 * Skills return a `code` plus a short message. Stack traces stay in the server
 * log — the planner and the UI receive only the code and one readable line, so
 * a failure costs a handful of tokens rather than a page of noise.
 */

export type BrowserErrorCode =
  | 'CAPTCHA_DETECTED'
  | 'POPUP_BLOCKING'
  | 'NEW_TAB_FAILED'
  | 'SEARCH_RESULTS_NOT_FOUND'
  | 'NAVIGATION_BLOCKED'
  | 'DYNAMIC_CONTENT_TIMEOUT'
  | 'ELEMENT_NOT_FOUND'
  | 'ELEMENT_NOT_INTERACTABLE'
  | 'ELEMENT_OCCLUDED'
  | 'ELEMENT_MOVING'
  | 'ELEMENT_DETACHED'
  | 'ELEMENT_NOT_VISIBLE'
  | 'ELEMENT_NOT_ENABLED'
  | 'STALE_OBSERVATION'
  | 'ACTION_NO_EFFECT'
  | 'NAVIGATION_FALLBACK_FAILED'
  | 'UNSAFE_ACTION_REFUSED'
  | 'INVALID_INPUT'
  | 'PAGE_CLOSED'
  | 'CONTEXT_CLOSED'
  | 'BROWSER_CLOSED';

export class BrowserError extends Error {
  constructor(
    public readonly code: BrowserErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'BrowserError';
  }
}

/** One short line — never a stack trace. */
export function describeError(error: unknown): { code: BrowserErrorCode | 'UNKNOWN'; error: string } {
  if (error instanceof BrowserError) {
    return { code: error.code, error: error.message };
  }
  const raw = error instanceof Error ? error.message : String(error);
  const first = raw.split('\n')[0].trim();

  /**
   * Playwright appends a call log to almost every action failure, and that log
   * contains "waiting for locator(...)". Testing the generic timeout pattern
   * against the whole message therefore stamped nearly every interaction
   * failure as DYNAMIC_CONTENT_TIMEOUT, hiding the real cause. Specific causes
   * are matched first, and the diagnostic line explaining WHY is preserved.
   */
  const why = raw
    .split('\n')
    .map((l) => l.trim())
    .find((l) => /element is |intercepts pointer events|outside of the viewport|subtree intercepts|not attached/i.test(l));
  const detail = why ? `${first} (${why})` : first;
  const bounded = detail.slice(0, 240);

  if (/ERR_(ABORTED|NAME_NOT_RESOLVED|CONNECTION|BLOCKED)/i.test(raw)) {
    return { code: 'NAVIGATION_BLOCKED', error: bounded };
  }

  // Playwright's actionability checks fail with distinct, specific reasons.
  // Each maps to its own code so a click blocked by a cookie banner is never
  // confused with one blocked by a CSS animation or a detached node — lumping
  // them together (as ELEMENT_NOT_INTERACTABLE alone did) hid which recovery
  // strategy (dismiss / wait / re-observe) actually applies. Order matters:
  // check the most specific phrase before the generic actionability ones.
  if (/not attached to the DOM/i.test(raw)) {
    return { code: 'ELEMENT_DETACHED', error: bounded };
  }
  if (/intercepts pointer events|subtree intercepts/i.test(raw)) {
    return { code: 'ELEMENT_OCCLUDED', error: bounded };
  }
  if (/not stable|element is moving/i.test(raw)) {
    return { code: 'ELEMENT_MOVING', error: bounded };
  }
  if (/not enabled/i.test(raw)) {
    return { code: 'ELEMENT_NOT_ENABLED', error: bounded };
  }
  if (/not visible|outside of the viewport/i.test(raw)) {
    return { code: 'ELEMENT_NOT_VISIBLE', error: bounded };
  }
  if (/not editable/i.test(raw)) {
    return { code: 'ELEMENT_NOT_INTERACTABLE', error: bounded };
  }
  if (/Timeout .* exceeded|waiting for locator/i.test(raw)) {
    return { code: 'DYNAMIC_CONTENT_TIMEOUT', error: bounded };
  }
  // Playwright reports all three closures with one message; classify it so the
  // agent never re-observes a dead session and crashes a second time.
  if (/Target page, context or browser has been closed|Target closed/i.test(raw)) {
    return { code: 'BROWSER_CLOSED', error: 'The browser session ended before the operation could run' };
  }
  return { code: 'UNKNOWN', error: first.slice(0, 200) };
}

/* ------------------------------------------------------------------ */

export interface PageBlocker {
  kind: 'captcha' | 'modal';
  /** Short human description for the planner and the activity trace. */
  detail: string;
}

/**
 * Signals that a human-verification challenge is present.
 *
 * Policy: JARVIS reports CAPTCHA and stops. It must never attempt to solve,
 * bypass, or evade bot detection.
 */
export const CAPTCHA_SIGNATURES = [
  'iframe[src*="recaptcha"]',
  'iframe[src*="hcaptcha"]',
  'iframe[title*="challenge" i]',
  '#challenge-form',
  '#cf-challenge-running',
  'form[action*="/errors/validateCaptcha"]',
  '[data-testid="captcha"]',
];

/** Text cues that accompany bot walls when no known iframe is present. */
export const CAPTCHA_TEXT_CUES = [
  'enter the characters you see',
  'type the characters you see',
  'verify you are a human',
  'are you a robot',
  'unusual traffic',
  'checking your browser before',
];
