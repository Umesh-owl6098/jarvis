/**
 * Checkpoint 18 — executes a parsed CalendarIntent against a CalendarClient.
 * Every branch here is READ-ONLY or PROPOSAL-ONLY — createEvent/updateEvent/
 * deleteEvent are never reachable from this file. Mutation only ever
 * happens through the separate, explicit PendingAction confirmation path
 * in task-manager.ts (§9), same boundary discipline as Gmail's send.
 */

import type { CalendarClient, CalendarEvent, CalendarProposal } from './types';
import type { CalendarIntent } from './intent';
import { formatLocal } from './datetime';
import { resolvePerson, describeUnresolved, summarize, type ResolutionSummary } from '@/core/capabilities/contacts/resolver';
import { getContactsClient, contactsAvailability } from '@/core/capabilities/contacts/resolve';

export interface CalendarOperationResult {
  status: 'completed' | 'failed' | 'blocked' | 'stopped';
  resultText: string;
  /** Set only for a successful proposal — task-manager.ts turns this into a PendingAction. */
  proposalCreated?: { kind: 'create' | 'update' | 'delete'; proposal: CalendarProposal };
  /** §19/§26 — set only when an attendee NAME (not an explicit email) was resolved through Contacts. */
  resolution?: ResolutionSummary;
}

function isAbortError(e: any): boolean {
  return e?.name === 'AbortError' || e?.code === 'ABORTED' || /aborted|cancelled/i.test(e?.message ?? '');
}

/** §20 — list/search show sender-equivalent fields only (title/time/location), never the full description. */
function formatEventLine(e: CalendarEvent, timezone: string): string {
  const loc = e.location ? ` @ ${e.location}` : '';
  return `• ${e.title} — ${formatLocal(e.start, timezone)} to ${formatLocal(e.end, timezone)}${loc}`;
}

/** Full detail, including description — only ever called for an event the user explicitly asked to look at closely (update/delete confirmation context), never for a bare list/search. */
function formatEventFull(e: CalendarEvent, timezone: string): string {
  const lines = [
    `Title: ${e.title}`,
    `When: ${formatLocal(e.start, timezone)} to ${formatLocal(e.end, timezone)}`,
  ];
  if (e.location) lines.push(`Location: ${e.location}`);
  if (e.attendees.length) lines.push(`Attendees: ${e.attendees.join(', ')}`);
  return lines.join('\n');
}

async function findSingleTarget(
  client: CalendarClient,
  query: string,
  signal?: AbortSignal
): Promise<{ event: CalendarEvent } | { ambiguous: CalendarEvent[] } | { none: true }> {
  const result = await client.searchEvents(query, 5, signal);
  if (result.events.length === 0) return { none: true };
  if (result.events.length > 1) return { ambiguous: result.events };
  return { event: result.events[0] };
}

/**
 * Time-based lookup fallback for "my 3 PM meeting" style references — no
 * real event is literally TITLED with its own start time, so a plain text
 * search for "3 PM" never matches anything (caught live: "Move my 3 PM
 * meeting to 4 PM" against a real event titled "Project Sync" found zero
 * results via search). Lists a 14-day window and matches on LOCAL
 * hour:minute instead.
 */
async function findByClockTime(
  client: CalendarClient,
  clockTime: { hour: number; minute: number },
  timezone: string,
  signal?: AbortSignal
): Promise<{ event: CalendarEvent } | { ambiguous: CalendarEvent[] } | { none: true }> {
  const now = new Date();
  const rangeStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const rangeEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 14).toISOString();
  const events = await client.listEvents(rangeStart, rangeEnd, timezone, 50, signal);
  const matches = events.filter((e) => {
    const local = new Date(e.start).toLocaleTimeString('en-US', { timeZone: timezone, hour: 'numeric', minute: '2-digit', hour12: false });
    const [h, m] = local.split(':').map(Number);
    return h === clockTime.hour && m === clockTime.minute;
  });
  if (matches.length === 0) return { none: true };
  if (matches.length > 1) return { ambiguous: matches };
  return { event: matches[0] };
}

/** Tries a plain text search first; falls back to time-based lookup only when text search finds nothing AND an old-time reference was actually given — never used to override a genuine text match. */
async function findUpdateTarget(
  client: CalendarClient,
  intent: CalendarIntent,
  signal?: AbortSignal
): Promise<{ event: CalendarEvent } | { ambiguous: CalendarEvent[] } | { none: true }> {
  const textResult = await findSingleTarget(client, intent.searchQuery ?? '', signal);
  if (!('none' in textResult)) return textResult;
  if (intent.oldClockTime) return findByClockTime(client, intent.oldClockTime, intent.timezone, signal);
  return textResult;
}

export async function runCalendarIntent(intent: CalendarIntent, client: CalendarClient, signal?: AbortSignal): Promise<CalendarOperationResult> {
  try {
    return await runInner(intent, client, signal);
  } catch (e: any) {
    if (isAbortError(e) || signal?.aborted) {
      return { status: 'stopped', resultText: 'Cancelled by user.' };
    }
    throw e;
  }
}

async function runInner(intent: CalendarIntent, client: CalendarClient, signal?: AbortSignal): Promise<CalendarOperationResult> {
  switch (intent.operation) {
    case 'list': {
      const events = await client.listEvents(intent.rangeStart!, intent.rangeEnd!, intent.timezone, 20, signal);
      if (events.length === 0) return { status: 'completed', resultText: 'No events found in that range.' };
      return { status: 'completed', resultText: events.map((e) => formatEventLine(e, intent.timezone)).join('\n') };
    }

    case 'search': {
      const q = intent.searchQuery ?? '';
      if (!q.trim()) return { status: 'failed', resultText: 'No search terms were understood in the request.' };
      const result = await client.searchEvents(q, 10, signal);
      if (result.events.length === 0) return { status: 'completed', resultText: `No events matched "${q}".` };
      return {
        status: 'completed',
        resultText: `Found ${result.events.length} event(s) matching "${q}":\n\n${result.events.map((e) => formatEventLine(e, intent.timezone)).join('\n')}`,
      };
    }

    case 'freebusy': {
      const availability = await client.freeBusy(intent.rangeStart!, intent.rangeEnd!, intent.timezone, signal);
      if (availability.free) {
        return { status: 'completed', resultText: `You're free from ${formatLocal(availability.start, intent.timezone)} to ${formatLocal(availability.end, intent.timezone)}.` };
      }
      const busyLines = availability.busy.map((b) => `busy ${formatLocal(b.start, intent.timezone)}–${formatLocal(b.end, intent.timezone)}`).join(', ');
      return { status: 'completed', resultText: `You're not fully free in that window — ${busyLines}.` };
    }

    case 'propose_create': {
      if (intent.needsClarification) {
        return { status: 'blocked', resultText: intent.needsClarification };
      }

      let start = intent.proposedStart;
      let end = intent.proposedEnd;

      // §12 — only a day-part was given (e.g. "tomorrow afternoon"): inspect
      // free/busy within that window and suggest the first open slot long
      // enough for the requested duration. Still a PROPOSAL, never created.
      if (!start && intent.dayPartOnly) {
        return { status: 'blocked', resultText: 'A day-part suggestion window was requested but not resolved — this should not happen; please specify an exact time.' };
      }
      if (!start || !end) {
        return { status: 'blocked', resultText: 'Could not resolve a specific date and time for this event.' };
      }

      // §19 — no explicit attendee email, but a candidate NAME is present
      // ("schedule a meeting with Ramesh...") — attempt Contacts
      // resolution BEFORE building the proposal. Any outcome other than a
      // single unambiguous match blocks with a clear message; an
      // unavailable Contacts capability falls through to "no attendees,"
      // exactly as if no name had been mentioned (never invents an invite).
      let attendees = intent.attendees ?? [];
      let resolution: ResolutionSummary | undefined;
      if (attendees.length === 0 && intent.attendeeNameHint) {
        const availability = contactsAvailability();
        if (availability.available) {
          const personResolution = await resolvePerson(intent.attendeeNameHint, getContactsClient(), signal);
          resolution = summarize(personResolution);
          if (personResolution.status === 'resolved') {
            attendees = [personResolution.email];
          } else {
            return { status: 'blocked', resultText: describeUnresolved(personResolution), resolution };
          }
        }
      }

      // §13 — conflict detection: never silently overwritten, always surfaced.
      const availability = await client.freeBusy(start, end, intent.timezone, signal);
      const conflict = availability.busy[0];

      const proposal: CalendarProposal = {
        kind: 'create',
        title: intent.title ?? 'Meeting',
        location: intent.location,
        start,
        end,
        timezone: intent.timezone,
        attendees,
        conflict: conflict ? await describeConflict(client, conflict, signal) : undefined,
      };

      const conflictLine = proposal.conflict
        ? `\n\n⚠ CONFLICT: you're busy ${formatLocal(proposal.conflict.start, intent.timezone)}–${formatLocal(proposal.conflict.end, intent.timezone)} (${proposal.conflict.title}).`
        : '';

      return {
        status: 'completed',
        resultText:
          `EVENT READY FOR CONFIRMATION\n\n` +
          `TITLE: ${proposal.title}\n` +
          `DATE: ${formatLocal(start, intent.timezone).split(',').slice(0, 2).join(',')}\n` +
          `START: ${formatLocal(start, intent.timezone)}\n` +
          `END: ${formatLocal(end, intent.timezone)}\n` +
          `TIMEZONE: ${intent.timezone}\n` +
          `ATTENDEES: ${proposal.attendees.length ? proposal.attendees.join(', ') : '(none)'}\n` +
          `LOCATION: ${proposal.location ?? '(none)'}` +
          conflictLine,
        proposalCreated: { kind: 'create', proposal },
        resolution,
      };
    }

    case 'propose_update': {
      if (intent.needsClarification) return { status: 'blocked', resultText: intent.needsClarification };
      const found = await findUpdateTarget(client, intent, signal);
      if ('none' in found) return { status: 'completed', resultText: `No matching event found for "${intent.searchQuery}".` };
      if ('ambiguous' in found) {
        return {
          status: 'blocked',
          resultText: `Multiple events match "${intent.searchQuery}" — please be more specific:\n\n${found.ambiguous.map((e) => formatEventLine(e, intent.timezone)).join('\n')}`,
        };
      }
      const existing = found.event;
      // The new time combines with the FOUND event's own existing date
      // unless the request explicitly named a new day too — "move my 3 PM
      // meeting to 4 PM" never mentions a date at all, so defaulting to
      // "same day, new time" is what the phrase actually means, not a guess.
      const { hour, minute } = intent.newClockTime!;
      const baseDate = intent.newDay
        ? new Date(new Date().setDate(new Date().getDate() + intent.newDay.daysFromNow))
        : new Date(existing.start);
      const newStartDate = new Date(baseDate);
      newStartDate.setHours(hour, minute, 0, 0);
      const newStart = newStartDate.toISOString();
      const duration = new Date(existing.end).getTime() - new Date(existing.start).getTime();
      const newEnd = new Date(new Date(newStart).getTime() + duration).toISOString();
      const proposal: CalendarProposal = {
        kind: 'update',
        title: existing.title,
        description: existing.description,
        location: existing.location,
        start: newStart,
        end: newEnd,
        timezone: intent.timezone,
        attendees: existing.attendees,
        existingEventId: existing.id,
        previous: { title: existing.title, start: existing.start, end: existing.end },
      };
      return {
        status: 'completed',
        resultText:
          `EVENT UPDATE READY FOR CONFIRMATION\n\n` +
          `TITLE: ${proposal.title}\n` +
          `OLD: ${formatLocal(existing.start, intent.timezone)} – ${formatLocal(existing.end, intent.timezone)}\n` +
          `NEW: ${formatLocal(newStart, intent.timezone)} – ${formatLocal(newEnd, intent.timezone)}`,
        proposalCreated: { kind: 'update', proposal },
      };
    }

    case 'propose_cancel': {
      const found = await findSingleTarget(client, intent.searchQuery ?? '', signal);
      if ('none' in found) return { status: 'completed', resultText: `No matching event found for "${intent.searchQuery}".` };
      if ('ambiguous' in found) {
        return {
          status: 'blocked',
          resultText: `Multiple events match "${intent.searchQuery}" — please be more specific:\n\n${found.ambiguous.map((e) => formatEventLine(e, intent.timezone)).join('\n')}`,
        };
      }
      const existing = found.event;
      const proposal: CalendarProposal = {
        kind: 'delete',
        title: existing.title,
        description: existing.description,
        location: existing.location,
        start: existing.start,
        end: existing.end,
        timezone: intent.timezone,
        attendees: existing.attendees,
        existingEventId: existing.id,
      };
      return {
        status: 'completed',
        resultText: `EVENT CANCELLATION READY FOR CONFIRMATION\n\n${formatEventFull(existing, intent.timezone)}`,
        proposalCreated: { kind: 'delete', proposal },
      };
    }
  }
}

async function describeConflict(client: CalendarClient, busy: { start: string; end: string }, signal?: AbortSignal): Promise<{ title: string; start: string; end: string }> {
  // freeBusy() only returns time windows, not titles (matches Google's own
  // freebusy.query API shape) — do one extra lookup via listEvents over
  // that exact window to name the conflicting event for the user.
  const matches = await client.listEvents(busy.start, busy.end, 'UTC', 1, signal);
  return { title: matches[0]?.title ?? '(existing event)', start: busy.start, end: busy.end };
}
