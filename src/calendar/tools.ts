import type { Tool } from '../agent/tools.js';
import { isGmailConfigured } from '../gmail/auth.js';
import {
  listCalendars,
  listEvents,
  getEvent,
  createEvent,
  updateEvent,
  deleteEvent,
  findFreeTime,
} from './client.js';

// ── Calendar config (merged from config.ts) ─────────────────────────

function parseHour(envVar: string, fallback: number): number {
  const raw = process.env[envVar];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  if (Number.isNaN(n) || n < 0 || n > 23) return fallback;
  return n;
}

/** Working day start hour (0-23). Configurable via CALENDAR_DAY_START_HOUR. */
const DAY_START_HOUR = parseHour('CALENDAR_DAY_START_HOUR', 8);

/** Working day end hour (0-23). Configurable via CALENDAR_DAY_END_HOUR. */
const DAY_END_HOUR = parseHour('CALENDAR_DAY_END_HOUR', 20);

// ── Tools ───────────────────────────────────────────────────────────

export function getCalendarTools(): Tool[] {
  if (!isGmailConfigured()) return [];

  return [
    {
      name: 'calendar_list',
      description: 'List all Google Calendars with their IDs and access roles.',
      input_schema: { type: 'object', properties: {}, required: [] },
      handler: async () => listCalendars(),
    },
    {
      name: 'calendar_events',
      description:
        'List upcoming calendar events. Defaults to next 7 days on the primary calendar. ' +
        'Returns event titles, times, locations, attendees, and IDs. ' +
        'Use this when user asks "what\'s on my calendar", "any meetings today", "what do I have this week", etc.',
      input_schema: {
        type: 'object',
        properties: {
          calendar_id: {
            type: 'string',
            description: 'Calendar ID (default "primary")',
          },
          days_ahead: {
            type: 'number',
            description: 'Number of days ahead to look (default 7)',
          },
          max_results: {
            type: 'number',
            description: 'Max events to return (default 10)',
          },
        },
        required: [],
      },
      handler: async (input) =>
        listEvents(
          (input.calendar_id as string) ?? 'primary',
          (input.days_ahead as number) ?? 7,
          (input.max_results as number) ?? 10,
        ),
    },
    {
      name: 'calendar_get_event',
      description:
        'Get full details of a specific calendar event by ID. ' +
        'To find an event first, call calendar_events to list upcoming events, then use the event_id from the results.',
      input_schema: {
        type: 'object',
        properties: {
          event_id: { type: 'string', description: 'Calendar event ID' },
          calendar_id: {
            type: 'string',
            description: 'Calendar ID (default "primary")',
          },
        },
        required: ['event_id'],
      },
      handler: async (input) =>
        getEvent(
          (input.calendar_id as string) ?? 'primary',
          input.event_id as string,
        ),
    },
    {
      name: 'calendar_create_event',
      description:
        'Create a new calendar event. Provide start and end as ISO 8601 datetime strings ' +
        '(e.g. "2026-03-15T10:00:00-07:00"). Optionally add attendees as comma-separated emails. ' +
        'Use this when user says "set up a call", "book a meeting", "schedule time", "add to calendar", etc.',
      input_schema: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: 'Event title' },
          start: { type: 'string', description: 'Start time (ISO 8601)' },
          end: { type: 'string', description: 'End time (ISO 8601)' },
          description: { type: 'string', description: 'Event description (optional)' },
          location: { type: 'string', description: 'Event location (optional)' },
          attendees: {
            type: 'string',
            description: 'Comma-separated attendee emails (optional)',
          },
          calendar_id: {
            type: 'string',
            description: 'Calendar ID (default "primary")',
          },
        },
        required: ['summary', 'start', 'end'],
      },
      handler: async (input) => {
        const attendees = input.attendees
          ? (input.attendees as string).split(',').map((e) => e.trim()).filter(Boolean)
          : undefined;
        return createEvent(
          (input.calendar_id as string) ?? 'primary',
          input.summary as string,
          input.start as string,
          input.end as string,
          input.description as string | undefined,
          input.location as string | undefined,
          attendees,
        );
      },
    },
    {
      name: 'calendar_update_event',
      description:
        'Update an existing calendar event. Only provide fields you want to change.',
      input_schema: {
        type: 'object',
        properties: {
          event_id: { type: 'string', description: 'Calendar event ID' },
          calendar_id: {
            type: 'string',
            description: 'Calendar ID (default "primary")',
          },
          summary: { type: 'string', description: 'New event title' },
          start: { type: 'string', description: 'New start time (ISO 8601)' },
          end: { type: 'string', description: 'New end time (ISO 8601)' },
          description: { type: 'string', description: 'New description' },
          location: { type: 'string', description: 'New location' },
        },
        required: ['event_id'],
      },
      handler: async (input) =>
        updateEvent(
          (input.calendar_id as string) ?? 'primary',
          input.event_id as string,
          {
            summary: input.summary as string | undefined,
            start: input.start as string | undefined,
            end: input.end as string | undefined,
            description: input.description as string | undefined,
            location: input.location as string | undefined,
          },
        ),
    },
    {
      name: 'calendar_delete_event',
      description: 'Delete a calendar event by ID.',
      input_schema: {
        type: 'object',
        properties: {
          event_id: { type: 'string', description: 'Calendar event ID' },
          calendar_id: {
            type: 'string',
            description: 'Calendar ID (default "primary")',
          },
        },
        required: ['event_id'],
      },
      handler: async (input) =>
        deleteEvent(
          (input.calendar_id as string) ?? 'primary',
          input.event_id as string,
        ),
    },
    {
      name: 'calendar_free_time',
      description:
        'Find free time slots on a given date. Shows busy periods and available slots. ' +
        'Provide date as YYYY-MM-DD. Default duration is 30 minutes (used for display only).',
      input_schema: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'Date to check (YYYY-MM-DD)' },
          duration_minutes: {
            type: 'number',
            description: 'Desired slot duration in minutes (default 30, for display)',
          },
          calendar_id: {
            type: 'string',
            description: 'Calendar ID (default "primary")',
          },
        },
        required: ['date'],
      },
      handler: async (input) => {
        const date = input.date as string;
        const calendarId = (input.calendar_id as string) ?? 'primary';
        const startH = String(DAY_START_HOUR).padStart(2, '0');
        const endH = String(DAY_END_HOUR).padStart(2, '0');
        const timeMin = `${date}T${startH}:00:00`;
        const timeMax = `${date}T${endH}:00:00`;
        return findFreeTime(calendarId, timeMin, timeMax);
      },
    },
  ];
}
