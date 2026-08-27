import { NextResponse } from 'next/server';
import { getTasksAuthUrl, isTasksOAuthConfigured } from '@/core/capabilities/tasks/auth';

/**
 * Checkpoint 20 §2 — starts INCREMENTAL Google OAuth authorization for the
 * Tasks scope, reusing the same OAuth client and the same registered
 * redirect URI as Gmail/Calendar/Contacts (no new redirect URI needed).
 * include_granted_scopes ensures existing access is preserved, not replaced.
 */
export async function GET() {
  if (!isTasksOAuthConfigured()) {
    return NextResponse.json(
      { error: 'Google OAuth is not configured. Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET — see GMAIL_SETUP.md / TASKS_SETUP.md.' },
      { status: 400 }
    );
  }
  return NextResponse.redirect(getTasksAuthUrl());
}
