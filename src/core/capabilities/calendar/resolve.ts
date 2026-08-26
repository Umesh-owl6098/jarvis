/**
 * Checkpoint 18 — picks the mock or real Calendar backend, mirroring
 * gmail/resolve.ts's exact precedent for the same reason: deterministic
 * local testing without live credentials, explicit opt-in, refused in
 * production.
 */

import type { CalendarClient } from './types';
import { MockCalendarClient } from './mock-client';
import { RealCalendarClient } from './client';
import { getAuthorizedCalendarClient, isCalendarAuthorized } from './auth';

let mockSingleton: MockCalendarClient | null = null;

export type CalendarAvailabilityStatus =
  | { available: true }
  | { available: false; reason: string };

export function calendarAvailability(): CalendarAvailabilityStatus {
  if (useMockCalendar()) return { available: true };
  if (!isCalendarAuthorized()) {
    return {
      available: false,
      reason: 'Calendar is not connected — visit /api/auth/calendar to grant Calendar access (see CALENDAR_SETUP.md).',
    };
  }
  return { available: true };
}

function useMockCalendar(): boolean {
  if (process.env.NODE_ENV === 'production') return false;
  return process.env.USE_MOCK_CALENDAR === 'true';
}

/** Throws if Calendar isn't available — callers check calendarAvailability() first. */
export function getCalendarClient(): CalendarClient {
  if (useMockCalendar()) {
    if (!mockSingleton) mockSingleton = new MockCalendarClient();
    return mockSingleton;
  }
  return new RealCalendarClient(getAuthorizedCalendarClient());
}
