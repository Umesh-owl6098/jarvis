/**
 * Checkpoint 20 §2-3 — Tasks OAuth. Same pattern as calendar/auth.ts and
 * contacts/auth.ts: reuses the exact same Google OAuth client and token
 * file as Gmail/Calendar/Contacts via incremental authorization
 * (include_granted_scopes) — never a separate token file, never invalidates
 * existing access.
 *
 * Scope requested (§3): https://www.googleapis.com/auth/tasks — verified
 * against the installed googleapis Tasks API v1 typings. Google Tasks API
 * only offers two scopes: `tasks` (read/write) and `tasks.readonly`
 * (read-only). Unlike Calendar (which has a narrower `calendar.events`
 * write scope separate from account-level `calendar`), Tasks has no
 * intermediate "mutate tasks but not task lists" scope — `tasks.readonly`
 * alone cannot satisfy §5's required create/update/complete/delete
 * operations, so the full `tasks` scope is the narrowest one that actually
 * works for this checkpoint's requirements.
 */

import { Auth } from 'googleapis';
import { createOAuthClient, getAuthUrl, saveTokens, loadTokens } from '@/core/capabilities/gmail/auth';

type OAuth2Client = Auth.OAuth2Client;

export const TASKS_SCOPES = ['https://www.googleapis.com/auth/tasks'];

export function isTasksOAuthConfigured(): boolean {
  return !!(process.env.GMAIL_CLIENT_ID && process.env.GMAIL_CLIENT_SECRET);
}

/** Incremental-auth URL — requests Gmail's/Calendar's/Contacts' existing scopes PLUS Tasks', preserving prior access via include_granted_scopes. */
export function getTasksAuthUrl(): string {
  return getAuthUrl(TASKS_SCOPES, true);
}

export function isTasksAuthorized(): boolean {
  if (!isTasksOAuthConfigured()) return false;
  const tokens = loadTokens();
  if (!tokens?.scope) return false;
  return TASKS_SCOPES.every((s) => tokens.scope!.includes(s));
}

/** An authorized OAuth2Client for Tasks API calls — throws if Tasks scope hasn't been granted yet. Callers check isTasksAuthorized() first for a clean message instead of a stack trace. */
export function getAuthorizedTasksClient(): OAuth2Client {
  const tokens = loadTokens();
  if (!tokens || !isTasksAuthorized()) {
    throw new Error('Tasks is not authorized yet — visit /api/auth/tasks to grant Tasks access (see TASKS_SETUP.md).');
  }
  const client = createOAuthClient();
  client.setCredentials(tokens);
  client.on('tokens', (newTokens) => {
    saveTokens({ ...tokens, ...newTokens });
  });
  return client;
}
