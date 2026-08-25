import { NextRequest, NextResponse } from 'next/server';
import { exchangeCodeForTokens } from '@/core/capabilities/gmail/auth';

/**
 * Checkpoint 17 §2 — the OAuth redirect target. Google sends the operator's
 * browser here with a one-time authorization code, which is exchanged for
 * tokens server-side and persisted to the local, gitignored token file —
 * the code itself is never logged, and the exchanged tokens never touch
 * the client/browser.
 */
export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get('code');
  const error = request.nextUrl.searchParams.get('error');

  if (error) {
    return NextResponse.json({ error: `Google denied authorization: ${error}` }, { status: 400 });
  }
  if (!code) {
    return NextResponse.json({ error: 'Missing authorization code' }, { status: 400 });
  }

  try {
    await exchangeCodeForTokens(code);
    return new NextResponse(
      '<html><body style="font-family: sans-serif; padding: 2rem;">' +
        '<h2>Gmail connected</h2><p>You can close this tab and return to JARVIS.</p>' +
        '</body></html>',
      { status: 200, headers: { 'Content-Type': 'text/html' } }
    );
  } catch (e: any) {
    return NextResponse.json({ error: `Failed to exchange authorization code: ${e?.message ?? 'unknown error'}` }, { status: 500 });
  }
}
