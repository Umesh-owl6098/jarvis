/**
 * Checkpoint 17 — picks the mock or real Gmail backend, mirroring the
 * existing USE_MOCK_ROUTER precedent (src/core/router/mode.ts) for the
 * exact same reason: deterministic local testing without live credentials,
 * explicit opt-in, refused in production.
 */

import type { GmailClient } from './types';
import { MockGmailClient } from './mock-client';
import { RealGmailClient } from './client';
import { getAuthorizedClient, isGmailAuthorized } from './auth';

let mockSingleton: MockGmailClient | null = null;

export type GmailAvailability =
  | { available: true }
  | { available: false; reason: string };

export function gmailAvailability(): GmailAvailability {
  if (useMockGmail()) return { available: true };
  if (!isGmailAuthorized()) {
    return { available: false, reason: 'Gmail is not connected — visit /api/auth/gmail to authorize an account (see GMAIL_SETUP.md).' };
  }
  return { available: true };
}

function useMockGmail(): boolean {
  // Refused in production, exactly like USE_MOCK_ROUTER — a mock mailbox
  // must never silently stand in for a real account outside local dev/test.
  if (process.env.NODE_ENV === 'production') return false;
  return process.env.USE_MOCK_GMAIL === 'true';
}

/** Throws if Gmail isn't available — callers check gmailAvailability() first for a clean user-facing message instead of a stack trace. */
export function getGmailClient(): GmailClient {
  if (useMockGmail()) {
    if (!mockSingleton) mockSingleton = new MockGmailClient();
    return mockSingleton;
  }
  return new RealGmailClient(getAuthorizedClient());
}
