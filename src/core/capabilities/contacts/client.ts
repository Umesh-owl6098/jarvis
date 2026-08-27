/**
 * Checkpoint 19 — RealContactsClient: the googleapis-backed implementation
 * of ContactsClient, using people.people.searchContacts (verified against
 * the installed People API v1 typings). Direct authorized API access —
 * never browser automation of contacts.google.com.
 */

import { people_v1, google, Auth } from 'googleapis';
import type { ContactsClient, ContactIdentity, ContactEmail } from './types';

type OAuth2Client = Auth.OAuth2Client;

const READ_MASK = 'names,emailAddresses,organizations';

function toContactIdentity(person: people_v1.Schema$Person): ContactIdentity | null {
  const name = person.names?.[0]?.displayName;
  const emails = (person.emailAddresses ?? [])
    .filter((e) => !!e.value)
    .map((e): ContactEmail => ({ email: e.value!, primary: !!e.metadata?.primary, label: e.type ?? undefined }));
  if (!name || emails.length === 0) return null; // §4 — a contact with no name or no email is not resolvable to anything useful
  return {
    id: person.resourceName ?? name,
    displayName: name,
    emailAddresses: emails,
    organization: person.organizations?.[0]?.name ?? undefined,
  };
}

export class RealContactsClient implements ContactsClient {
  readonly backend = 'real' as const;
  private people: people_v1.People;

  constructor(auth: OAuth2Client) {
    this.people = google.people({ version: 'v1', auth });
  }

  async search(query: string, max: number, signal?: AbortSignal): Promise<ContactIdentity[]> {
    const resp = await this.people.people.searchContacts(
      { query, readMask: READ_MASK, pageSize: Math.min(max, 30) },
      { signal }
    );
    return (resp.data.results ?? [])
      .map((r) => (r.person ? toContactIdentity(r.person) : null))
      .filter((c): c is ContactIdentity => c !== null);
  }
}
