/**
 * Checkpoint 29 — the ENTIRE persistent reminder schema. Deliberately
 * narrow, mirroring preferences/types.ts's own discipline (Checkpoint 23):
 * a closed set of fields, nothing generic. A reminder is inert user-
 * authored TEXT plus a trigger time — never a stored Gmail/Calendar/Tasks
 * payload, never a session transcript, never anything that could later be
 * mistaken for executable instructions.
 */

export type ReminderStatus = 'scheduled' | 'delivered' | 'cancelled';

export interface Reminder {
  id: string;
  text: string;
  triggerAt: string; // ISO instant
  createdAt: string; // ISO instant
  status: ReminderStatus;
  deliveredAt?: string; // ISO instant — set only when status transitions to 'delivered'
  cancelledAt?: string; // ISO instant — set only when status transitions to 'cancelled'
  /**
   * Checkpoint 29 HOLD — ISO instant, set ONLY once a UI poll has actually
   * drained/acknowledged this delivered reminder (reminderStore's own
   * drainUnsurfaced()). Absent means "delivered but not yet shown to
   * anyone." This is the durable answer to "has anyone actually seen
   * this notification yet" — replacing an earlier, purely in-memory
   * delivery queue that was silently wiped by a server restart between
   * the reminder firing and the UI's next poll (see the HOLD report's own
   * scenario-C/D trace). Three-state lifecycle, all via this one field
   * plus `status`: scheduled -> delivered (surfacedAt absent) -> delivered
   * (surfacedAt set). Never meaningful on a 'scheduled' or 'cancelled'
   * reminder; production code only ever sets it via drainUnsurfaced(),
   * which only ever touches 'delivered' records.
   */
  surfacedAt?: string;
}

/** The on-disk wrapper shape — an object (never a bare array at the top level, so the schema can grow without breaking old files) holding the reminder list. */
export interface ReminderFile {
  reminders: Reminder[];
}

const REMINDER_STATUSES: readonly ReminderStatus[] = ['scheduled', 'delivered', 'cancelled'];
const MAX_TEXT_LENGTH = 500;

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

function isValidIso(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  const t = new Date(v).getTime();
  return Number.isFinite(t) && v === new Date(t).toISOString();
}

/**
 * Individually type/range-checks every known field of ONE raw reminder
 * record; anything else (wrong-shaped, missing required field, invalid
 * date, invalid status, unknown extra keys) is dropped entirely — never
 * partially trusted, never crashes the caller. Mirrors
 * preferences/types.ts's sanitizePreferences() discipline, applied
 * per-record rather than per-field since reminders are a LIST.
 */
export function sanitizeReminder(raw: unknown): Reminder | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;

  if (!isNonEmptyString(obj.id)) return null;
  if (!isNonEmptyString(obj.text)) return null;
  if (obj.text.length > MAX_TEXT_LENGTH) return null;
  if (!isValidIso(obj.triggerAt)) return null;
  if (!isValidIso(obj.createdAt)) return null;
  if (typeof obj.status !== 'string' || !(REMINDER_STATUSES as string[]).includes(obj.status)) return null;

  const out: Reminder = {
    id: obj.id,
    text: obj.text,
    triggerAt: obj.triggerAt,
    createdAt: obj.createdAt,
    status: obj.status as ReminderStatus,
  };
  if (obj.deliveredAt !== undefined) {
    if (!isValidIso(obj.deliveredAt)) return null;
    out.deliveredAt = obj.deliveredAt;
  }
  if (obj.cancelledAt !== undefined) {
    if (!isValidIso(obj.cancelledAt)) return null;
    out.cancelledAt = obj.cancelledAt;
  }
  if (obj.surfacedAt !== undefined) {
    if (!isValidIso(obj.surfacedAt)) return null;
    out.surfacedAt = obj.surfacedAt;
  }
  return out;
}

/**
 * The ONLY path anything read from disk reaches the in-memory reminder
 * list through. A non-object/array-shaped file, a missing `reminders`
 * array, or any individual malformed record all degrade to "as many valid
 * records as could be salvaged" (possibly zero) rather than throwing.
 * Duplicate ids are collapsed to the LAST occurrence (mirrors how a plain
 * object/Map would naturally dedupe if this were ever loaded that way) so
 * a corrupted file with a repeated id can never produce two live reminders
 * sharing one id.
 */
export function sanitizeReminderFile(raw: unknown): Reminder[] {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return [];
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.reminders)) return [];

  const byId = new Map<string, Reminder>();
  for (const entry of obj.reminders) {
    const r = sanitizeReminder(entry);
    if (r) byId.set(r.id, r);
  }
  return [...byId.values()];
}

/** A safe, display-only record of a reminder that fired — never re-fed into the task runner or any capability. Distinct from Reminder itself: this is what a UI poll of /api/reminders/due receives, derived live from reminderStore's own persisted surfacedAt transition (see reminders/delivery.ts) — not a separate stored object. */
export interface ReminderDelivery {
  reminderId: string;
  text: string;
  triggerAt: string;
  deliveredAt: string;
}
