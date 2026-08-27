import { NextResponse } from 'next/server';
import { getContactsAuthUrl, isContactsOAuthConfigured } from '@/core/capabilities/contacts/auth';

/**
 * Checkpoint 19 §2 — starts INCREMENTAL Google OAuth authorization for the
 * read-only Contacts scope, reusing the same OAuth client and the same
 * registered redirect URI as Gmail/Calendar (no new redirect URI needed).
 * include_granted_scopes ensures existing Gmail/Calendar access is
 * preserved, not replaced.
 */
export async function GET() {
  if (!isContactsOAuthConfigured()) {
    return NextResponse.json(
      { error: 'Google OAuth is not configured. Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET — see GMAIL_SETUP.md / CONTACTS_SETUP.md.' },
      { status: 400 }
    );
  }
  return NextResponse.redirect(getContactsAuthUrl());
}
