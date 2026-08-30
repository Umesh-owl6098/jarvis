/**
 * Checkpoint 21 fix — a deterministic compound-request classifier,
 * analogous to query-shape.ts's isPersonalQueryShape(). Reuses each
 * capability's OWN concept vocabulary (never redefines it — imported
 * directly from gmail/calendar/tasks intent.ts, one source of truth) plus
 * the shared query-shape check, to answer one question: "does this single
 * utterance name more than one capability's concept, in a personal-query
 * way?"
 *
 * This exists because orchestrator.ts's 4 supported patterns are
 * deliberately narrow regex shapes (the checkpoint's own "small supported
 * grammar" constraint) — real users phrase compound requests in ways none
 * of those 4 exact shapes cover ("What meetings and tasks do I have
 * today?" is semantically identical to the one literal example pattern 4
 * supports, just worded differently). The fix is NOT one more regex per
 * failed sentence (that lesson was already learned in Checkpoint 20) —
 * it's recognizing the underlying SHAPE (two-or-more capability concepts,
 * asked about personally) so a single capability's own classifier can
 * never silently swallow only its half of a request that clearly named
 * more than one capability.
 */

import { GMAIL_CONCEPT_RE } from '@/core/capabilities/gmail/intent';
import { CALENDAR_CONCEPT_RE } from '@/core/capabilities/calendar/intent';
import { TASKS_CONCEPT_RE, NEED_TO_DO_RE } from '@/core/capabilities/tasks/intent';
import { GMAIL_EMAIL_VERB_RE } from './gmail-guard';
import { isPersonalQueryShape } from './query-shape';

export type CapabilityConcept = 'calendar' | 'gmail' | 'tasks';

export function detectConcepts(text: string): CapabilityConcept[] {
  const concepts: CapabilityConcept[] = [];
  if (CALENDAR_CONCEPT_RE.test(text)) concepts.push('calendar');
  if (GMAIL_CONCEPT_RE.test(text)) concepts.push('gmail');
  if (TASKS_CONCEPT_RE.test(text) || NEED_TO_DO_RE.test(text)) concepts.push('tasks');
  return concepts;
}

export interface CompoundQueryMatch {
  concepts: CapabilityConcept[];
}

/**
 * True only for a genuine multi-concept PERSONAL QUERY — never for a
 * mutation-trigger phrase ("schedule a meeting...", "remind me to...",
 * "draft an email...") that happens to mention another concept word too.
 * Those are imperative commands, not questions, so isPersonalQueryShape()
 * (which requires an interrogative/imperative READ shape like "what"/
 * "did"/"show") already excludes them by construction — a create/propose
 * trigger never starts with those words. Also excludes any text a Gmail
 * draft/send phrase already claims (the same guard every capability's own
 * detector uses), so a draft BODY mentioning multiple concepts is never
 * mistaken for a compound request about the assistant's own capabilities.
 */
export function detectCompoundQuery(text: string): CompoundQueryMatch | null {
  const t = text.trim();
  if (GMAIL_EMAIL_VERB_RE.test(t)) return null;
  const concepts = detectConcepts(t);
  if (concepts.length < 2) return null;
  if (!isPersonalQueryShape(t)) return null;
  return { concepts };
}
