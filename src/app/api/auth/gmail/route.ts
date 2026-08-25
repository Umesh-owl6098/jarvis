import { NextResponse } from 'next/server';
import { getAuthUrl, isGmailOAuthConfigured } from '@/core/capabilities/gmail/auth';

/**
 * Checkpoint 17 §2 — starts the OAuth authorization-code flow. Visiting
 * this route redirects the operator's own browser to Google's consent
 * screen; nothing here ever touches a password.
 */
export async function GET() {
  if (!isGmailOAuthConfigured()) {
    return NextResponse.json(
      { error: 'Gmail OAuth is not configured. Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET — see GMAIL_SETUP.md.' },
      { status: 400 }
    );
  }
  return NextResponse.redirect(getAuthUrl());
}
