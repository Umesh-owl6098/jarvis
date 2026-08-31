/**
 * Checkpoint 23 — the ENTIRE persistent-preference schema. Deliberately
 * small and closed: three optional, allowlisted fields, nothing else. This
 * is NOT general memory — no free-form Record<string, unknown>, no arbitrary
 * user utterances, no retrieved-content fields. If a future checkpoint
 * needs a new preference, it gets added here explicitly, one named field at
 * a time — never a generic bag callers can stuff anything into.
 */

export type EmailStyle = 'concise' | 'detailed' | 'formal' | 'casual';
export type MeetingLocation = 'google_meet' | 'none';

export interface UserPreferences {
  meetingDurationMinutes?: number;
  emailStyle?: EmailStyle;
  defaultMeetingLocation?: MeetingLocation;
}

export const PREFERENCE_FIELDS = ['meetingDurationMinutes', 'emailStyle', 'defaultMeetingLocation'] as const;
export type PreferenceField = (typeof PREFERENCE_FIELDS)[number];

const EMAIL_STYLES: readonly EmailStyle[] = ['concise', 'detailed', 'formal', 'casual'];
const MEETING_LOCATIONS: readonly MeetingLocation[] = ['google_meet', 'none'];

function isValidDuration(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v) && v > 0 && v <= 24 * 60;
}

/**
 * The ONLY path anything read from disk (or from a raw parsed command
 * value) reaches the in-memory preference object through. Never a
 * pass-through — each of the three known fields is individually
 * type/range-checked; anything else (an unknown key, a wrong-shaped value,
 * a whole non-object payload) is silently dropped rather than crashing or
 * being carried forward. This is what makes "malformed/corrupted file
 * fails safely" and "unknown fields ignored" true by construction: a
 * corrupted file and a stray extra key both just produce fewer valid
 * fields, never an error and never smuggled-through data.
 */
export function sanitizePreferences(raw: unknown): UserPreferences {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const obj = raw as Record<string, unknown>;
  const out: UserPreferences = {};
  if (isValidDuration(obj.meetingDurationMinutes)) out.meetingDurationMinutes = obj.meetingDurationMinutes;
  if (typeof obj.emailStyle === 'string' && (EMAIL_STYLES as string[]).includes(obj.emailStyle)) {
    out.emailStyle = obj.emailStyle as EmailStyle;
  }
  if (typeof obj.defaultMeetingLocation === 'string' && (MEETING_LOCATIONS as string[]).includes(obj.defaultMeetingLocation)) {
    out.defaultMeetingLocation = obj.defaultMeetingLocation as MeetingLocation;
  }
  return out;
}

export function isValidDurationValue(v: unknown): v is number {
  return isValidDuration(v);
}

export function isValidEmailStyle(v: unknown): v is EmailStyle {
  return typeof v === 'string' && (EMAIL_STYLES as string[]).includes(v);
}

export function isValidMeetingLocation(v: unknown): v is MeetingLocation {
  return typeof v === 'string' && (MEETING_LOCATIONS as string[]).includes(v);
}

export const FIELD_LABEL: Record<PreferenceField, string> = {
  meetingDurationMinutes: 'default meeting duration',
  emailStyle: 'email style',
  defaultMeetingLocation: 'default meeting location',
};
