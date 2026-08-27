/**
 * Checkpoint 19 — mock/real backend resolver, mirroring gmail/resolve.ts
 * and calendar/resolve.ts's exact precedent.
 */

import type { ContactsClient } from './types';
import { MockContactsClient } from './mock-client';
import { RealContactsClient } from './client';
import { getAuthorizedContactsClient, isContactsAuthorized } from './auth';

let mockSingleton: MockContactsClient | null = null;

export type ContactsAvailability = { available: true } | { available: false; reason: string };

export function contactsAvailability(): ContactsAvailability {
  if (useMockContacts()) return { available: true };
  if (!isContactsAuthorized()) {
    return {
      available: false,
      reason: 'Contacts is not connected — visit /api/auth/contacts to grant read-only Contacts access (see CONTACTS_SETUP.md).',
    };
  }
  return { available: true };
}

function useMockContacts(): boolean {
  if (process.env.NODE_ENV === 'production') return false;
  return process.env.USE_MOCK_CONTACTS === 'true';
}

export function getContactsClient(): ContactsClient {
  if (useMockContacts()) {
    if (!mockSingleton) mockSingleton = new MockContactsClient();
    return mockSingleton;
  }
  return new RealContactsClient(getAuthorizedContactsClient());
}
