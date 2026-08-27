/**
 * Checkpoint 19 §5 — normalized Contacts types. Google People API objects
 * (their own field-metadata trees, source provenance, dozens of optional
 * fields) never leak past this boundary. Deliberately minimal — no
 * addresses, birthdays, notes, or photos, per §4's explicit "do not expose
 * unnecessary private contact fields."
 */

export interface ContactEmail {
  email: string;
  primary: boolean;
  label?: string; // "home" | "work" | "other" | custom
}

export interface ContactIdentity {
  id: string;
  displayName: string;
  emailAddresses: ContactEmail[];
  organization?: string;
}

/**
 * §6 — the resolution outcome, never a bare ContactIdentity or a raw email
 * string. Forces every caller (Gmail, Calendar) to handle ambiguity and
 * no-match explicitly rather than silently defaulting to "the first result."
 */
export type PersonResolution =
  | { status: 'resolved'; query: string; contact: ContactIdentity; email: string }
  /** Multiple DIFFERENT contacts matched the name — §7. */
  | { status: 'ambiguous'; query: string; candidates: ContactIdentity[] }
  /** Exactly one contact matched, but it has multiple emails with no clear primary — §8. */
  | { status: 'ambiguous_email'; query: string; contact: ContactIdentity }
  | { status: 'not_found'; query: string };

export interface ContactsClient {
  readonly backend: 'real' | 'mock';
  /** Prefix-matches a name/email against the user's saved contacts. */
  search(query: string, max: number, signal?: AbortSignal): Promise<ContactIdentity[]>;
}
