/**
 * Checkpoint 22 fix — JARVIS session identity. One opaque, cryptographically
 * random ID per browser tab/UI session (see src/app/page.tsx, generated via
 * crypto.randomUUID() once per mount — reload starts a new session, matching
 * the "one tab = one JARVIS conversational session" choice). Never derived
 * from email, contact info, IP, OAuth token, or any other personal data —
 * it identifies a CONVERSATION, not a person.
 *
 * This is the ONLY place that decides what counts as a valid session id and
 * what happens when a request doesn't carry one. The rule that matters:
 * a missing/invalid session id must NEVER fall back to a shared/fixed
 * "default" string — that would silently re-collapse every caller back
 * into one global session, exactly the bug this checkpoint fixes. Instead
 * each bad/missing request gets its OWN fresh, isolated random id, good for
 * that one request only.
 *
 * A sessionId is a conversation handle, not an identity — this module (and
 * every store it gates) provides SESSION ISOLATION, not authentication or
 * multi-user authorization. It proves two conversations can't read or
 * write each other's state; it proves nothing about who is on the other
 * end of either one.
 */

import { nanoid } from 'nanoid';

// Bounded length, safe charset — matches crypto.randomUUID() output
// (lowercase hex + hyphens) and nanoid's own alphabet, but is intentionally
// a little more permissive so any reasonable opaque client-generated token
// validates. Never trust an unbounded or arbitrary-charset value from a
// request header.
const SESSION_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;

export function isValidSessionId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID_RE.test(value);
}

/**
 * Resolves the session id for one incoming request. A valid header value is
 * used as-is; anything missing or malformed gets a brand-new random id
 * instead of a shared fallback — that request is treated as its own
 * single-request "session" (isolated from every other caller), never
 * merged into a common default.
 */
export function resolveSessionId(headerValue: string | null | undefined): string {
  if (isValidSessionId(headerValue)) return headerValue;
  return nanoid();
}

/** Debug-safe representation for logs/UI — never the raw id. */
export function redactSessionId(sessionId: string): string {
  if (sessionId.length <= 8) return '••••';
  return `${sessionId.slice(0, 4)}…${sessionId.slice(-4)}`;
}
