import { NextResponse } from 'next/server';
import { getCalendarAuthUrl, isCalendarOAuthConfigured } from '@/core/capabilities/calendar/auth';

/**
 * Checkpoint 18 §2 — starts INCREMENTAL Google OAuth authorization for
 * Calendar scopes, reusing the same OAuth client and the same registered
 * redirect URI as Gmail's own /api/auth/gmail/callback (no new redirect
 * URI needs to be added in Google Cloud Console). include_granted_scopes
 * ensures Gmail's existing access is preserved, not replaced.
 */
export async function GET() {
  if (!isCalendarOAuthConfigured()) {
    return NextResponse.json(
      { error: 'Google OAuth is not configured. Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET — see GMAIL_SETUP.md / CALENDAR_SETUP.md.' },
      { status: 400 }
    );
  }
  return NextResponse.redirect(getCalendarAuthUrl());
}
