/**
 * Checkpoint 29 §11, HOLD-revised — the reminder UI delivery endpoint. Per
 * the CP29 architecture report: this codebase's existing SSE
 * (/api/agent/stream) is request-scoped and closes when its one task
 * finishes — there is no mechanism for the server to push an event into
 * the browser outside a live request, and no precedent anywhere in this
 * codebase for a persistent broadcast channel. A background reminder
 * timer firing has no live request/controller to write into. Pull-based
 * polling is therefore the smallest, most consistent-with-existing-
 * patterns choice — the frontend already has an established precedent
 * for exactly this shape (page.tsx's own 20s setInterval poll of
 * /api/omniroute/health).
 *
 * GET atomically surfaces every delivered-but-not-yet-surfaced reminder
 * (reminderStore.drainUnsurfaced(), via delivery.ts's
 * drainDueDeliveries()) — a delivery is returned to any UI at most once,
 * EVER, durably (the "surfaced" fact is persisted, not held in memory —
 * see the HOLD report for why the earlier in-memory-only queue could
 * silently lose a delivery across a server restart). Returns only the
 * safe, already-sanitized ReminderDelivery shape — reminder TEXT is
 * display data here, never executed, never re-interpreted, and this
 * route performs no other side effect: no external source is read, no
 * capability is invoked, no reminder is created/cancelled/re-scheduled.
 */

import { NextResponse } from 'next/server';
import { drainDueDeliveries } from '@/core/reminders/delivery';

export const dynamic = 'force-dynamic';

export async function GET() {
  const deliveries = drainDueDeliveries();
  return NextResponse.json({ deliveries });
}
