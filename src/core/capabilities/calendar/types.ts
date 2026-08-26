/**
 * Checkpoint 18 §5 — normalized Calendar types. Google Calendar API objects
 * (their own recurrence rules, extended properties, conferencing data) never
 * leak past this boundary — everything downstream sees only these flat
 * shapes, same discipline as the Gmail capability's MailMessage/MailThread.
 */

export interface CalendarEvent {
  id: string;
  calendarId: string;
  title: string;
  description?: string;
  location?: string;
  /** ISO 8601, always timezone-explicit (never a bare date/time assumed to be UTC). */
  start: string;
  end: string;
  timezone: string;
  attendees: string[];
  status: 'confirmed' | 'tentative' | 'cancelled';
  htmlLink?: string;
}

export interface CalendarSearchResult {
  query: string;
  events: CalendarEvent[];
}

export interface CalendarAvailability {
  start: string;
  end: string;
  timezone: string;
  busy: { start: string; end: string }[];
  free: boolean;
}

/**
 * §8 — a proposal is NEVER itself a committed calendar mutation; it's the
 * "here's what I'm about to do" structure shown to the user before any
 * create/update/delete call is made. TaskManager turns an accepted
 * proposal into a PendingAction (calendar/pending-action.ts), never the
 * other way around.
 */
export interface CalendarProposal {
  kind: 'create' | 'update' | 'delete';
  title: string;
  description?: string;
  location?: string;
  start: string;
  end: string;
  timezone: string;
  attendees: string[];
  /** Set for update/delete — the event being changed. */
  existingEventId?: string;
  /** Set for update — the event's state before the proposed change, for an old-vs-new diff. */
  previous?: { title: string; start: string; end: string };
  /** Set when the proposed time overlaps an existing event — surfaced to the user, never silently overridden. */
  conflict?: { title: string; start: string; end: string };
}

/**
 * §4 — the controlled Calendar capability boundary. Both the real
 * (googleapis-backed) and mock implementations satisfy this exact contract.
 * No bulk operations, no calendar-list management, no sharing/ACL changes —
 * event CRUD on the primary calendar only.
 */
export interface CalendarClient {
  readonly backend: 'real' | 'mock';
  listEvents(rangeStart: string, rangeEnd: string, timezone: string, max: number, signal?: AbortSignal): Promise<CalendarEvent[]>;
  searchEvents(query: string, max: number, signal?: AbortSignal): Promise<CalendarSearchResult>;
  getEvent(eventId: string, signal?: AbortSignal): Promise<CalendarEvent | null>;
  freeBusy(rangeStart: string, rangeEnd: string, timezone: string, signal?: AbortSignal): Promise<CalendarAvailability>;
  createEvent(proposal: CalendarProposal, signal?: AbortSignal): Promise<CalendarEvent>;
  updateEvent(eventId: string, proposal: CalendarProposal, signal?: AbortSignal): Promise<CalendarEvent>;
  deleteEvent(eventId: string, signal?: AbortSignal): Promise<void>;
}
