/**
 * Checkpoint 19 §2-3 — Contacts OAuth. Same pattern as calendar/auth.ts:
 * reuses the exact same Google OAuth client and token file as Gmail/
 * Calendar via incremental authorization (include_granted_scopes) — never
 * a separate token file, never invalidates existing Gmail/Calendar access.
 *
 * Scope requested: https://www.googleapis.com/auth/contacts.readonly —
 * read-only access to the user's saved Google Contacts. Verified against
 * the installed googleapis People API v1 typings (people.people.
 * searchContacts). No write scope requested anywhere — Contacts is
 * read-only in this checkpoint (§30: no create/update/delete capability
 * exists at all, not just "unused").
 */

import { Auth } from 'googleapis';
import { createOAuthClient, getAuthUrl, saveTokens, loadTokens } from '@/core/capabilities/gmail/auth';

type OAuth2Client = Auth.OAuth2Client;

export const CONTACTS_SCOPES = ['https://www.googleapis.com/auth/contacts.readonly'];

export function isContactsOAuthConfigured(): boolean {
  return !!(process.env.GMAIL_CLIENT_ID && process.env.GMAIL_CLIENT_SECRET);
}

/** Incremental-auth URL — requests Gmail's + Calendar's existing scopes PLUS Contacts', preserving prior access. */
export function getContactsAuthUrl(): string {
  return getAuthUrl(CONTACTS_SCOPES, true);
}

export function isContactsAuthorized(): boolean {
  if (!isContactsOAuthConfigured()) return false;
  const tokens = loadTokens();
  if (!tokens?.scope) return false;
  return CONTACTS_SCOPES.every((s) => tokens.scope!.includes(s));
}

export function getAuthorizedContactsClient(): OAuth2Client {
  const tokens = loadTokens();
  if (!tokens || !isContactsAuthorized()) {
    throw new Error(
      'Contacts is not authorized yet — visit /api/auth/contacts to grant read-only Contacts access (see CONTACTS_SETUP.md).'
    );
  }
  const client = createOAuthClient();
  client.setCredentials(tokens);
  client.on('tokens', (newTokens) => {
    saveTokens({ ...tokens, ...newTokens });
  });
  return client;
}
