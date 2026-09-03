/**
 * Checkpoint 27 — structured shapes for the daily briefing. Built from
 * Calendar/Tasks/Gmail's own ALREADY-normalized types (CalendarEvent/
 * TaskItem/MailMessage) — this file adds no new capability data, only a
 * bounded, display-safe VIEW over it. Every field here is deliberately
 * something already safe to show (title/time/sender/subject/due date/
 * status) — never .description, never .notes, never a full Gmail body.
 */

import type { DayPart } from '@/core/capabilities/calendar/datetime';

export type { DayPart };

export interface BriefingScope {
  daysFromNow: number;
  dayLabel: string;
  dayPart: DayPart | null;
  rangeStart: string;
  rangeEnd: string;
}

export type BriefingSourceStatus = 'ok' | 'unavailable' | 'failed';

export interface BriefingCalendarEventView {
  id: string;
  title: string;
  start: string;
  end: string;
  timezone: string;
  location?: string;
  attendees: string[];
}

export interface BriefingCalendarData {
  status: BriefingSourceStatus;
  reason?: string;
  remainingCount: number;
  nextEvent?: BriefingCalendarEventView;
  events: BriefingCalendarEventView[];
}

export interface BriefingTaskView {
  id: string;
  taskListId: string;
  title: string;
  due?: string;
}

export interface BriefingTasksData {
  status: BriefingSourceStatus;
  reason?: string;
  overdueCount: number;
  dueTodayCount: number;
  incompleteCount: number;
  overdue: BriefingTaskView[];
  dueToday: BriefingTaskView[];
}

export interface BriefingMailView {
  id: string;
  from: string;
  subject: string;
  date: string;
  unread: boolean;
}

export interface BriefingGmailData {
  status: BriefingSourceStatus;
  reason?: string;
  recentCount: number;
  unreadCount: number;
  unread: BriefingMailView[];
}

export type AttentionTier = 1 | 2 | 3;

/**
 * A safe, bounded reference back to the real item — enough to re-look-up
 * (id / taskListId) or re-display (label), never enough to reconstruct a
 * Gmail body, Calendar description, or Task notes. Mirrors CP22's own
 * ContextTargetRef shape (kind + id + title) deliberately.
 */
export interface BriefingItemRef {
  capability: 'calendar' | 'gmail' | 'tasks';
  id: string;
  taskListId?: string;
  label: string;
}

export interface AttentionItem {
  tier: AttentionTier;
  ref: BriefingItemRef;
  label: string;
}

export interface DailyBriefing {
  scope: BriefingScope;
  calendar: BriefingCalendarData;
  tasks: BriefingTasksData;
  gmail: BriefingGmailData;
  attention: AttentionItem[];
  attentionTotalCount: number;
}
