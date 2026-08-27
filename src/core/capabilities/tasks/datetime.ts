/**
 * Checkpoint 20 §7 — reuses Calendar's date/timezone discipline directly
 * (resolveDayPhrase, DEFAULT_TIMEZONE, formatLocal) rather than
 * reimplementing it. The one thing Tasks needs that Calendar's module
 * doesn't provide is a DATE-ONLY due timestamp: Google Tasks' `due` field
 * discards the time-of-day portion entirely (see tasks/types.ts), so
 * building it from Calendar's `isoAt(daysFromNow, hour, minute)` would be
 * wrong in a positive-UTC-offset timezone — local midnight converted to UTC
 * can land on the PREVIOUS UTC calendar date there, silently shifting the
 * due date back a day. taskDueIso() sidesteps that by formatting the local
 * Y/M/D directly as a UTC-midnight RFC 3339 string for that date, never
 * round-tripping through a timezone conversion.
 */

export { resolveDayPhrase, DEFAULT_TIMEZONE, formatLocal, type ResolvedDay } from '@/core/capabilities/calendar/datetime';

export function taskDueIso(daysFromNow: number): string {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + daysFromNow);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}T00:00:00.000Z`;
}

/** Formats a Tasks `due` timestamp as a bare date (no time-of-day — there isn't one to show). */
export function formatDueDate(due: string): string {
  const [y, m, d] = due.slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}
