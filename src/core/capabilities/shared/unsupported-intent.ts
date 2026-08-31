/**
 * Post-CP23 fix — deterministic detection of a request for a capability
 * JARVIS genuinely does not have (currently: placing a phone call), so it
 * can fail fast and honestly instead of falling all the way through to the
 * generic browser/OmniRoute planner, which has no way to know "call GV"
 * isn't a web task and spends real time (and real planner calls) trying
 * to find a website for it before eventually giving up.
 *
 * Concept-based, not a special case for any one name: the classifier keys
 * on IMPERATIVE STRUCTURE — the command must OPEN with "call"/"phone"/
 * "ring" as its own leading verb (optionally after "please"/a wake word
 * already stripped) — never on the bare presence of the word "call"
 * anywhere in the text. This is what keeps it from stealing:
 *   - questions ("What is a function call?", "What does call mean in
 *     JavaScript?") — they open with "what", not the verb;
 *   - explanations ("Explain a function call") — opens with "explain";
 *   - noun-phrase idioms ("a call option") — never at the START as a bare
 *     imperative;
 *   - browser/navigation commands naming "Call" as part of a title/brand
 *     ("Open the Call of Duty website", "Search for Call of Duty") — they
 *     open with "open"/"search", not "call", and even a bare "Call of
 *     Duty" is excluded by name below since its object contains "of duty".
 * A command whose creation VERB is "create/add a task to call X" is Tasks'
 * own content (see shared/tasks-guard.ts) and is claimed by Tasks' own
 * detector, checked before this one in task-manager.ts, so it never
 * reaches this classifier at all.
 */

const PHONE_CALL_RE = /^(?:please\s+)?(?:call|phone|ring)\s+(.+?)[.!]?$/i;

/**
 * Excludes the rare case where the "target" itself is clearly not a person
 * reference — e.g. someone literally typing "Call of Duty" as a bare
 * command. Deliberately narrow: this does NOT need to validate that the
 * target IS a real person (that's Contacts' job, and this guard never
 * calls Contacts at all — see the module comment above) — it only needs to
 * rule out the one brand-name shape that could otherwise slip through the
 * leading-verb check.
 */
function looksLikeNonPersonObject(target: string): boolean {
  return /\bof\s+duty\b/i.test(target);
}

export function isUnsupportedPhoneCallIntent(text: string): boolean {
  const t = text.trim();
  const m = PHONE_CALL_RE.exec(t);
  if (!m) return false;
  const target = m[1].trim();
  if (!target) return false;
  if (looksLikeNonPersonObject(target)) return false;
  return true;
}
