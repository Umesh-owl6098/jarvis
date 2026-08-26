/**
 * Checkpoint 18 — RealCalendarClient: the googleapis-backed implementation
 * of CalendarClient. Direct authorized Calendar API access — never browser
 * automation of calendar.google.com, per §1's explicit instruction.
 */

import { calendar_v3, google, Auth } from 'googleapis';
import type { CalendarClient, CalendarEvent, CalendarProposal, CalendarSearchResult, CalendarAvailability } from './types';

type OAuth2Client = Auth.OAuth2Client;

const PRIMARY = 'primary';

function toCalendarEvent(ev: calendar_v3.Schema$Event): CalendarEvent {
  const start = ev.start?.dateTime ?? ev.start?.date ?? '';
  const end = ev.end?.dateTime ?? ev.end?.date ?? '';
  const timezone = ev.start?.timeZone ?? ev.end?.timeZone ?? 'UTC';
  const status: CalendarEvent['status'] =
    ev.status === 'cancelled' ? 'cancelled' : ev.status === 'tentative' ? 'tentative' : 'confirmed';
  return {
    id: ev.id!,
    calendarId: PRIMARY,
    title: ev.summary ?? '(no title)',
    description: ev.description ?? undefined,
    location: ev.location ?? undefined,
    start,
    end,
    timezone,
    attendees: (ev.attendees ?? []).map((a) => a.email!).filter(Boolean),
    status,
    htmlLink: ev.htmlLink ?? undefined,
  };
}

function toRequestBody(proposal: CalendarProposal): calendar_v3.Schema$Event {
  return {
    summary: proposal.title,
    description: proposal.description,
    location: proposal.location,
    start: { dateTime: proposal.start, timeZone: proposal.timezone },
    end: { dateTime: proposal.end, timeZone: proposal.timezone },
    attendees: proposal.attendees.map((email) => ({ email })),
  };
}

export class RealCalendarClient implements CalendarClient {
  readonly backend = 'real' as const;
  private calendar: calendar_v3.Calendar;

  constructor(auth: OAuth2Client) {
    this.calendar = google.calendar({ version: 'v3', auth });
  }

  async listEvents(rangeStart: string, rangeEnd: string, _timezone: string, max: number, signal?: AbortSignal): Promise<CalendarEvent[]> {
    const resp = await this.calendar.events.list(
      {
        calendarId: PRIMARY,
        timeMin: rangeStart,
        timeMax: rangeEnd,
        maxResults: max,
        singleEvents: true,
        orderBy: 'startTime',
      },
      { signal }
    );
    return (resp.data.items ?? []).map(toCalendarEvent);
  }

  async searchEvents(query: string, max: number, signal?: AbortSignal): Promise<CalendarSearchResult> {
    const resp = await this.calendar.events.list(
      { calendarId: PRIMARY, q: query, maxResults: max, singleEvents: true, orderBy: 'startTime' },
      { signal }
    );
    return { query, events: (resp.data.items ?? []).map(toCalendarEvent) };
  }

  async getEvent(eventId: string, signal?: AbortSignal): Promise<CalendarEvent | null> {
    try {
      const resp = await this.calendar.events.get({ calendarId: PRIMARY, eventId }, { signal });
      return toCalendarEvent(resp.data);
    } catch {
      return null;
    }
  }

  async freeBusy(rangeStart: string, rangeEnd: string, timezone: string, signal?: AbortSignal): Promise<CalendarAvailability> {
    const resp = await this.calendar.freebusy.query(
      { requestBody: { timeMin: rangeStart, timeMax: rangeEnd, items: [{ id: PRIMARY }] } },
      { signal }
    );
    const busy = (resp.data.calendars?.[PRIMARY]?.busy ?? []).map((b) => ({ start: b.start!, end: b.end! }));
    return { start: rangeStart, end: rangeEnd, timezone, busy, free: busy.length === 0 };
  }

  async createEvent(proposal: CalendarProposal, signal?: AbortSignal): Promise<CalendarEvent> {
    const resp = await this.calendar.events.insert(
      { calendarId: PRIMARY, requestBody: toRequestBody(proposal) },
      { signal }
    );
    return toCalendarEvent(resp.data);
  }

  async updateEvent(eventId: string, proposal: CalendarProposal, signal?: AbortSignal): Promise<CalendarEvent> {
    const resp = await this.calendar.events.update(
      { calendarId: PRIMARY, eventId, requestBody: toRequestBody(proposal) },
      { signal }
    );
    return toCalendarEvent(resp.data);
  }

  async deleteEvent(eventId: string, signal?: AbortSignal): Promise<void> {
    await this.calendar.events.delete({ calendarId: PRIMARY, eventId }, { signal });
  }
}
