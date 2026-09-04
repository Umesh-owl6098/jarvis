/**
 * Checkpoint 29 — ReminderStore: a minimal local persistent store for
 * scheduled reminders, backed by its own single small JSON file. Mirrors
 * preferences/store.ts's (Checkpoint 23) exact persistence discipline —
 * lazy path resolution, fail-safe load, same-filesystem atomic
 * temp-write-then-rename, restrictive file mode — but is deliberately its
 * OWN separate file, never `.gmail-token.json` (OAuth) or
 * `.jarvis-preferences.json` (config): different lifecycle, different
 * content, different reason to exist. See preferences/store.ts's own
 * module comment for the full "session vs. persistent local state"
 * argument, which applies here almost verbatim — a reminder is neither
 * ephemeral per-tab session state (CP22) nor global operator configuration
 * (CP23); it is its own third category: persistent-until-fired-or-
 * cancelled local user data, addressed by its own opaque id, never keyed
 * by sessionId.
 *
 * No in-memory cache — every read re-parses the file from disk, same
 * reasoning as preferences/store.ts (a small file, correctness over a
 * negligible cost, and what makes "a second process/instance pointed at
 * the same path sees what the first wrote" true without extra
 * invalidation logic).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import path from 'path';
import { sanitizeReminderFile, type Reminder, type ReminderStatus } from './types';

// Overridable via JARVIS_REMINDERS_PATH so test scripts can point at a
// throwaway temp file — tests must NEVER write into the developer's real
// reminders file. Resolved LAZILY for the same reason preferences/store.ts
// resolves JARVIS_PREFERENCES_PATH lazily — see that file's own comment.
function defaultPath(): string {
  return process.env.JARVIS_REMINDERS_PATH || path.join(process.cwd(), '.jarvis-reminders.json');
}

export class ReminderStore {
  constructor(private readonly explicitPath?: string) {}

  private get filePath(): string {
    return this.explicitPath ?? defaultPath();
  }

  /** Fail-safe load — see preferences/store.ts's own load() comment; the same discipline applied to a list of records via sanitizeReminderFile(). */
  private load(): Reminder[] {
    if (!existsSync(this.filePath)) return [];
    try {
      const raw = JSON.parse(readFileSync(this.filePath, 'utf-8'));
      return sanitizeReminderFile(raw);
    } catch {
      return [];
    }
  }

  /** Atomic write — identical mechanism to preferences/store.ts's save(): same-directory uniquely-named temp file, then rename() over the real path. */
  private save(reminders: Reminder[]): void {
    const dir = path.dirname(this.filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmpPath = path.join(dir, `.${path.basename(this.filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
    writeFileSync(tmpPath, JSON.stringify({ reminders }, null, 2), { mode: 0o600 });
    try {
      renameSync(tmpPath, this.filePath);
    } catch (e) {
      try { unlinkSync(tmpPath); } catch {}
      throw e;
    }
  }

  getAll(): Reminder[] {
    return this.load();
  }

  get(id: string): Reminder | null {
    return this.load().find((r) => r.id === id) ?? null;
  }

  /** Scheduled reminders, ordered by triggerAt ascending — the deterministic ordering §15 requires for listing/"next reminder". */
  scheduledSorted(): Reminder[] {
    return this.load()
      .filter((r) => r.status === 'scheduled')
      .sort((a, b) => (a.triggerAt < b.triggerAt ? -1 : a.triggerAt > b.triggerAt ? 1 : 0));
  }

  /** Appends a brand-new reminder. Caller is responsible for generating an opaque id — this never overwrites an existing id (a colliding id is a caller bug, not something this store silently resolves). */
  add(reminder: Reminder): void {
    const all = this.load();
    if (all.some((r) => r.id === reminder.id)) return; // never silently duplicate/overwrite — the caller must mint a fresh id
    all.push(reminder);
    this.save(all);
  }

  /**
   * Transitions one reminder's status atomically (single read-modify-write
   * of the whole file — see the module's own concurrency note below). A
   * reminder that no longer exists, or is already in a terminal status
   * different from what the caller expects, is left untouched and `false`
   * is returned — this is what makes double-cancel/double-deliver safe:
   * the SECOND call to transition an already-cancelled/already-delivered
   * reminder is a harmless no-op, never a crash, never a corrupted record.
   */
  private transition(id: string, from: ReminderStatus[], to: ReminderStatus, timestampField: 'deliveredAt' | 'cancelledAt', now: Date): boolean {
    const all = this.load();
    const idx = all.findIndex((r) => r.id === id);
    if (idx === -1) return false;
    if (!from.includes(all[idx].status)) return false;
    all[idx] = { ...all[idx], status: to, [timestampField]: now.toISOString() };
    this.save(all);
    return true;
  }

  /** Idempotent — cancelling an already-cancelled or already-delivered reminder returns false and changes nothing. */
  cancel(id: string, now: Date = new Date()): boolean {
    return this.transition(id, ['scheduled'], 'cancelled', 'cancelledAt', now);
  }

  /** Idempotent — delivering an already-delivered or already-cancelled reminder returns false and changes nothing (this is the exactly-once guarantee: status IS the delivery record, not in-memory state). */
  markDelivered(id: string, now: Date = new Date()): boolean {
    return this.transition(id, ['scheduled'], 'delivered', 'deliveredAt', now);
  }

  /** Atomically marks every currently-scheduled, currently-due (triggerAt <= now) reminder as delivered in ONE read-modify-write, returning the list of reminders that were actually transitioned. Called by the scheduler's own fire() and by startup recovery — a fire (or a restart racing a fire) never delivers the same reminder twice, since this only ever touches 'scheduled' records. Deliberately does NOT set surfacedAt — "delivered" and "shown to a UI" are two separate, independently-durable facts (see drainUnsurfaced() below and the HOLD report's own scenario trace for why they were merged into one lossy in-memory step before this fix). */
  markAllDueDelivered(now: Date): Reminder[] {
    const all = this.load();
    const delivered: Reminder[] = [];
    const next = all.map((r) => {
      if (r.status === 'scheduled' && r.triggerAt <= now.toISOString()) {
        const updated: Reminder = { ...r, status: 'delivered', deliveredAt: now.toISOString() };
        delivered.push(updated);
        return updated;
      }
      return r;
    });
    if (delivered.length > 0) this.save(next);
    return delivered;
  }

  /**
   * Checkpoint 29 HOLD — atomically marks every currently-delivered,
   * not-yet-surfaced reminder as surfaced, returning the list just
   * transitioned. This is the DURABLE replacement for the old in-memory
   * delivery queue: a UI poll calling this is the only thing that can ever
   * mark a reminder surfaced, the transition is persisted before the
   * caller renders anything, and — critically — nothing about "was this
   * shown yet" lives in process memory, so it survives any number of
   * server restarts between a reminder firing and a UI actually polling.
   * Once surfacedAt is set, this reminder is permanently excluded from
   * every future call, on this process or any later one — restart
   * reconstruction is automatic because there is nothing to reconstruct:
   * the persisted file IS the queue.
   */
  drainUnsurfaced(now: Date = new Date()): Reminder[] {
    const all = this.load();
    const surfaced: Reminder[] = [];
    const next = all.map((r) => {
      if (r.status === 'delivered' && !r.surfacedAt) {
        const updated: Reminder = { ...r, surfacedAt: now.toISOString() };
        surfaced.push(updated);
        return updated;
      }
      return r;
    });
    if (surfaced.length > 0) this.save(next);
    return surfaced;
  }

  get count(): number {
    return this.load().length;
  }
}

export const reminderStore = new ReminderStore();
