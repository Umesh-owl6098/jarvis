/**
 * Transcript → command normalisation.
 *
 * Deliberately tiny. The microphone is only live *inside* JARVIS, so the wake
 * word is optional decoration rather than a gate — all this does is strip a
 * leading address ("Jarvis, …", "Hey Jarvis …") and tidy dictation artifacts.
 * It must never rewrite the body of a command: "open amazon.com" has to reach
 * the agent byte-for-byte identical to the typed version.
 */

export interface NormalizedCommand {
  /** Exactly what the recogniser produced. */
  raw: string;
  /** What gets submitted to the agent. */
  command: string;
  /** True when a leading wake word was removed. */
  hadWakeWord: boolean;
  /** False when there is nothing worth submitting. */
  submittable: boolean;
}

/**
 * Leading address only, and only at the very start:
 *   "jarvis, …" | "hey jarvis …" | "ok jarvis: …"
 * A trailing/embedded "jarvis" is left alone, so "tell me about Jarvis
 * architecture" survives intact.
 */
const WAKE_PREFIX = /^\s*(?:hey|ok|okay|yo)?\s*jarvis\b[\s,.:;!-]*/i;

/** Dictation often yields a trailing period that would look odd in the box. */
const TRAILING_PUNCT = /[.,;:!?\s]+$/;

/**
 * Speech engines commonly transcribe spoken domains as "amazon dot com".
 * Restoring the dot is safe and keeps the deterministic bootstrap working.
 */
const SPOKEN_DOT = /\b(\w[\w-]*)\s+dot\s+(com|org|net|io|dev|ai|co|gov|edu|uk)\b/gi;

export function normalizeVoiceCommand(rawInput: string): NormalizedCommand {
  const raw = String(rawInput ?? '');
  let text = raw.trim();

  const hadWakeWord = WAKE_PREFIX.test(text);
  if (hadWakeWord) text = text.replace(WAKE_PREFIX, '');

  text = text.replace(SPOKEN_DOT, (_m, host: string, tld: string) => `${host}.${tld}`);
  text = text.replace(/\s{2,}/g, ' ').replace(TRAILING_PUNCT, '').trim();

  return {
    raw,
    command: text,
    hadWakeWord,
    // A bare wake word ("Jarvis") carries no instruction; nothing to submit.
    submittable: text.length > 0,
  };
}
