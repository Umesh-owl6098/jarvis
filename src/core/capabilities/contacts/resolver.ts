/**
 * Checkpoint 19 §6-8/§11 — the shared identity-resolution service. Gmail
 * and Calendar both call this SAME function rather than duplicating
 * lookup/ambiguity logic — exactly the "small reusable resolver" §11 asks
 * for. Deterministic only: no LLM call to disambiguate or to guess which
 * contact/email was meant (§12) — every non-single-unambiguous-match
 * outcome is returned as data for the caller to surface to the user, never
 * resolved by picking "the first one."
 */

import type { ContactsClient, PersonResolution } from './types';

/** §26 — a compact, UI-safe summary of a resolution attempt, threaded up through Gmail/Calendar's ExecutionResult for the Developer Inspector's optional RESOLUTION row. Never carries a full candidate list — just the query, outcome, and (if resolved) the single email. */
export interface ResolutionSummary {
  query: string;
  status: PersonResolution['status'];
  email?: string;
}

export function summarize(resolution: PersonResolution): ResolutionSummary {
  return { query: resolution.query, status: resolution.status, email: resolution.status === 'resolved' ? resolution.email : undefined };
}

export async function resolvePerson(name: string, client: ContactsClient, signal?: AbortSignal): Promise<PersonResolution> {
  const query = name.trim();
  if (!query) return { status: 'not_found', query };

  const results = await client.search(query, 10, signal);
  if (results.length === 0) return { status: 'not_found', query };

  // §7 — multiple DIFFERENT contacts matched (e.g. two "John Smith"
  // entries) — never pick one just because it's first.
  if (results.length > 1) return { status: 'ambiguous', query, candidates: results };

  const contact = results[0];
  if (contact.emailAddresses.length === 1) {
    return { status: 'resolved', query, contact, email: contact.emailAddresses[0].email };
  }

  // §8 — one contact, multiple emails. Only resolve automatically if the
  // SOURCE data itself marks one as primary — never our own preference.
  const primary = contact.emailAddresses.find((e) => e.primary);
  if (primary) {
    return { status: 'resolved', query, contact, email: primary.email };
  }
  return { status: 'ambiguous_email', query, contact };
}

/** A short, safe-to-show clarification message for any non-resolved outcome — shared so Gmail and Calendar phrase this identically. */
export function describeUnresolved(resolution: Exclude<PersonResolution, { status: 'resolved' }>): string {
  if (resolution.status === 'not_found') {
    return `I couldn't find a contact matching "${resolution.query}" — please specify an explicit email address.`;
  }
  if (resolution.status === 'ambiguous') {
    const lines = resolution.candidates
      .map((c, i) => `${i + 1}. ${c.displayName} — ${c.emailAddresses[0]?.email ?? '(no email)'}`)
      .join('\n');
    return `I found ${resolution.candidates.length} contacts matching "${resolution.query}":\n\n${lines}\n\nWhich one?`;
  }
  // ambiguous_email
  const emails = resolution.contact.emailAddresses.map((e) => e.label ? `${e.label} (${e.email})` : e.email).join(' or ');
  return `${resolution.contact.displayName} has multiple email addresses — use ${emails}?`;
}
