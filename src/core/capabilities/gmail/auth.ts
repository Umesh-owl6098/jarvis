/**
 * Checkpoint 17 §2-3 — Gmail OAuth. Proper authorization-code OAuth2 via
 * Google's own `googleapis`/`google-auth-library` — never a stored
 * password, never a scraped login, never a hardcoded token.
 *
 * Scopes requested (§3 — minimum practical, read-only preferred):
 *   - gmail.readonly  — list/search/read messages and threads. Needed for
 *     every READ/SEARCH/SUMMARIZE operation. Cannot send or modify anything.
 *   - gmail.compose   — create, read, and send DRAFTS only. Needed for
 *     DRAFT and the confirmed SEND step. Deliberately NOT gmail.modify or
 *     the full mail.google.com scope — compose cannot delete a message,
 *     permanently trash anything, or bulk-relabel; it can only create a
 *     draft and send a draft it created. This is the narrowest scope that
 *     still allows the checkpoint's own required "create draft" +
 *     "send an existing confirmed draft" operations.
 *
 * No Drive, Contacts, or Calendar scope is requested — out of scope for
 * this checkpoint (§3).
 */

import { google, Auth } from 'googleapis';
import path from 'path';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';

// Re-exported from `googleapis` itself (not the top-level `google-auth-library`
// package) — `googleapis`'s gmail() factory expects auth clients built from
// ITS OWN bundled google-auth-library, which TypeScript treats as a
// structurally distinct type from an independently-installed copy of the
// same package at a different version.
type OAuth2Client = Auth.OAuth2Client;
type Credentials = Auth.Credentials;

export const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
];

// Local-only, never committed (see .gitignore) — the standard pattern for a
// single-user local dev tool (same idea as `gh`/`gcloud`'s own local
// credential files). No database needed for this, matching §10's own "no
// database needed yet" philosophy applied to the token store too.
//
// Checkpoint 18: this ONE token file is shared by Gmail AND Calendar — it's
// really "the Google account token for this app," not something inherently
// Gmail-only. TOKEN_PATH/saveTokens/loadTokens are exported so
// calendar/auth.ts can reuse this exact file/logic instead of duplicating
// it (§2's "do not create a completely separate OAuth stack"). Nothing
// about their behavior changes for Gmail's own callers.
export const TOKEN_PATH = path.join(process.cwd(), '.gmail-token.json');

export function isGmailOAuthConfigured(): boolean {
  return !!(process.env.GMAIL_CLIENT_ID && process.env.GMAIL_CLIENT_SECRET);
}

export function getRedirectUri(): string {
  return process.env.GMAIL_REDIRECT_URI || 'http://localhost:3000/api/auth/gmail/callback';
}

export function createOAuthClient(): OAuth2Client {
  if (!isGmailOAuthConfigured()) {
    throw new Error(
      'Gmail OAuth is not configured — set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET (see GMAIL_SETUP.md).'
    );
  }
  return new google.auth.OAuth2(process.env.GMAIL_CLIENT_ID, process.env.GMAIL_CLIENT_SECRET, getRedirectUri());
}

/**
 * §CP18 — extraScopes/includeGrantedScopes are additive-only parameters:
 * every existing call site (Gmail's own /api/auth/gmail route) calls this
 * with no arguments and gets EXACTLY the same URL/behavior as before.
 * Calendar's incremental-auth flow calls getAuthUrl(CALENDAR_SCOPES, true)
 * — include_granted_scopes:true is what makes Google issue a token
 * covering the UNION of the previously-granted Gmail scopes plus the newly
 * requested Calendar ones, rather than silently dropping Gmail access.
 */
export function getAuthUrl(extraScopes: string[] = [], includeGrantedScopes = false): string {
  const client = createOAuthClient();
  return client.generateAuthUrl({
    access_type: 'offline', // required to receive a refresh_token
    prompt: 'consent', // forces a refresh_token on every authorization, not just the first
    scope: [...GMAIL_SCOPES, ...extraScopes],
    include_granted_scopes: includeGrantedScopes,
  });
}

export async function exchangeCodeForTokens(code: string): Promise<void> {
  const client = createOAuthClient();
  const { tokens } = await client.getToken(code);
  saveTokens(tokens);
}

export function saveTokens(tokens: Credentials): void {
  writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2), { mode: 0o600 });
}

export function loadTokens(): Credentials | null {
  if (!existsSync(TOKEN_PATH)) return null;
  try {
    return JSON.parse(readFileSync(TOKEN_PATH, 'utf-8'));
  } catch {
    return null;
  }
}

export function isGmailAuthorized(): boolean {
  return isGmailOAuthConfigured() && loadTokens() !== null;
}

export function clearGmailAuthorization(): void {
  if (existsSync(TOKEN_PATH)) unlinkSync(TOKEN_PATH);
}

/** An authorized OAuth2Client, with tokens loaded and a listener that persists Google's own automatic refresh-token rotation. Throws if not yet authorized — callers check isGmailAuthorized() first. */
export function getAuthorizedClient(): OAuth2Client {
  const tokens = loadTokens();
  if (!tokens) {
    throw new Error('Gmail is not authorized yet — visit /api/auth/gmail to connect an account (see GMAIL_SETUP.md).');
  }
  const client = createOAuthClient();
  client.setCredentials(tokens);
  client.on('tokens', (newTokens) => {
    // google-auth-library only fires this with a NEW refresh_token when
    // Google actually issues one (rare) — merge, never drop the existing one.
    saveTokens({ ...tokens, ...newTokens });
  });
  return client;
}
