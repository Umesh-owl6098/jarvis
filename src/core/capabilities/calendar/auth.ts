/**
 * Checkpoint 18 §2-3 — Calendar OAuth. Deliberately NOT a separate OAuth
 * stack: reuses the exact same Google OAuth client (GMAIL_CLIENT_ID/
 * GMAIL_CLIENT_SECRET — these are a Google Cloud OAuth client's own
 * credentials, not Gmail-specific despite the env var name) and the exact
 * same token file as the Gmail capability. Requesting Calendar scopes is
 * handled as INCREMENTAL authorization (include_granted_scopes: true) —
 * approving it does not revoke or replace Gmail's existing access; the
 * resulting token covers the union of both.
 *
 * Scopes requested (§3 — minimum practical, read-only preferred):
 *   - calendar.readonly — list/search events, free/busy. Needed for every
 *     READ/SEARCH/CHECK AVAILABILITY operation. Cannot create, modify, or
 *     delete anything.
 *   - calendar.events    — create/update/delete EVENTS only. Needed for the
 *     confirmed CREATE/UPDATE/CANCEL step. Deliberately NOT the full
 *     `calendar` scope — events cannot change calendar settings, sharing,
 *     or the list of calendars themselves.
 *
 * No broader Google account access is requested.
 */

import { Auth } from 'googleapis';
import { createOAuthClient, getAuthUrl, saveTokens, loadTokens, TOKEN_PATH } from '@/core/capabilities/gmail/auth';

type OAuth2Client = Auth.OAuth2Client;

export const CALENDAR_SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events',
];

export function isCalendarOAuthConfigured(): boolean {
  return !!(process.env.GMAIL_CLIENT_ID && process.env.GMAIL_CLIENT_SECRET);
}

/** The incremental-auth URL — requests Gmail's existing scopes PLUS Calendar's, with include_granted_scopes so prior Gmail access is preserved, not replaced. */
export function getCalendarAuthUrl(): string {
  return getAuthUrl(CALENDAR_SCOPES, true);
}

/**
 * True only if a token exists AND Google's own recorded `scope` string
 * (part of the token response) actually includes the calendar scopes —
 * NOT just "a token file exists," since that file may only hold Gmail's
 * narrower grant from Checkpoint 17. This is what lets the app correctly
 * say "Calendar isn't authorized yet" even while Gmail already works,
 * prompting the SAME incremental consent flow rather than a confusing
 * generic re-auth.
 */
export function isCalendarAuthorized(): boolean {
  if (!isCalendarOAuthConfigured()) return false;
  const tokens = loadTokens();
  if (!tokens?.scope) return false;
  return CALENDAR_SCOPES.every((s) => tokens.scope!.includes(s));
}

export { TOKEN_PATH };

/** An authorized OAuth2Client for Calendar API calls — throws if Calendar scopes haven't been granted yet. Callers check isCalendarAuthorized() first for a clean message instead of a stack trace. */
export function getAuthorizedCalendarClient(): OAuth2Client {
  const tokens = loadTokens();
  if (!tokens || !isCalendarAuthorized()) {
    throw new Error(
      'Calendar is not authorized yet — visit /api/auth/calendar to grant Calendar access (see CALENDAR_SETUP.md).'
    );
  }
  const client = createOAuthClient();
  client.setCredentials(tokens);
  client.on('tokens', (newTokens) => {
    saveTokens({ ...tokens, ...newTokens });
  });
  return client;
}
