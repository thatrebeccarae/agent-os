import { calendar, type calendar_v3 } from '@googleapis/calendar';
import { getOAuth2Client } from '../gmail/auth.js';
import { wrapAndDetect } from '../security/content-boundary.js';
import { handleGoogleApiError } from '../google/errors.js';

function getCalendar(): calendar_v3.Calendar {
  return calendar({ version: 'v3', auth: getOAuth2Client() });
}

function handleCalendarError(err: unknown): string {
  return handleGoogleApiError(err, 'Google Calendar');
}

function formatDateTime(dt: calendar_v3.Schema$EventDateTime | undefined): string {
  if (!dt) return 'unknown';
  if (dt.dateTime) {
    const d = new Date(dt.dateTime);
    return d.toLocaleString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: dt.timeZone ?? undefined,
    });
  }
  // All-day event
  if (dt.date) return dt.date;
  return 'unknown';
}

function formatEvent(event: calendar_v3.Schema$Event, calendarName?: string): string {
  const lines: string[] = [];
  lines.push(`Event: ${event.summary ?? '(no title)'}`);

  const start = formatDateTime(event.start);
  const end = formatDateTime(event.end);
  const tz = event.start?.timeZone ?? '';
  if (event.start?.date) {
    // All-day event
    lines.push(`When: ${start} (all day)${event.end?.date && event.end.date !== event.start.date ? ` – ${event.end.date}` : ''}`);
  } else {
    lines.push(`When: ${start} – ${end}${tz ? ` (${tz})` : ''}`);
  }

  if (event.location) lines.push(`Where: ${event.location}`);
  if (calendarName) lines.push(`Calendar: ${calendarName}`);
  lines.push(`Status: ${event.status ?? 'unknown'}`);
  lines.push(`ID: ${event.id}`);

  if (event.attendees && event.attendees.length > 0) {
    const attendeeList = event.attendees
      .map((a) => `${a.email}${a.responseStatus ? ` (${a.responseStatus})` : ''}`)
      .join(', ');
    lines.push(`Attendees: ${attendeeList}`);
  }

  if (event.hangoutLink) lines.push(`Meet: ${event.hangoutLink}`);
  if (event.description) {
    let desc = event.description.length > 500
      ? event.description.slice(0, 500) + '...'
      : event.description;
    desc = wrapAndDetect(desc, `calendar:${event.summary ?? event.id ?? 'unknown'}`);
    lines.push(`Description: ${desc}`);
  }

  return lines.join('\n');
}

export async function listCalendars(): Promise<string> {
  try {
    const cal = getCalendar();
    const res = await cal.calendarList.list();
    const calendars = res.data.items ?? [];
    if (calendars.length === 0) return 'No calendars found.';

    const lines = calendars.map((c) => {
      const primary = c.primary ? ' (primary)' : '';
      const access = c.accessRole ? ` [${c.accessRole}]` : '';
      return `${c.summary ?? '(untitled)'}${primary}${access} — ID: ${c.id}`;
    });

    return `${calendars.length} calendar(s):\n${lines.join('\n')}`;
  } catch (err) {
    return handleCalendarError(err);
  }
}

export async function listEvents(
  calendarId: string,
  daysAhead: number,
  maxResults: number,
): Promise<string> {
  try {
    const cal = getCalendar();
    const timeMin = new Date().toISOString();
    const timeMax = new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000).toISOString();

    const res = await cal.events.list({
      calendarId,
      timeMin,
      timeMax,
      maxResults,
      singleEvents: true,
      orderBy: 'startTime',
    });

    const events = res.data.items ?? [];
    if (events.length === 0) return `No events in the next ${daysAhead} day(s).`;

    const formatted = events.map((e) => formatEvent(e));
    return `${events.length} event(s) in the next ${daysAhead} day(s):\n\n${formatted.join('\n\n')}`;
  } catch (err) {
    return handleCalendarError(err);
  }
}

export async function getEvent(calendarId: string, eventId: string): Promise<string> {
  try {
    const cal = getCalendar();
    const res = await cal.events.get({ calendarId, eventId });
    return formatEvent(res.data);
  } catch (err) {
    return handleCalendarError(err);
  }
}

export async function createEvent(
  calendarId: string,
  summary: string,
  start: string,
  end: string,
  description?: string,
  location?: string,
  attendees?: string[],
): Promise<string> {
  try {
    const cal = getCalendar();

    const eventBody: calendar_v3.Schema$Event = {
      summary,
      start: { dateTime: start },
      end: { dateTime: end },
    };
    if (description) eventBody.description = description;
    if (location) eventBody.location = location;
    if (attendees && attendees.length > 0) {
      eventBody.attendees = attendees.map((email) => ({ email: email.trim() }));
    }

    const res = await cal.events.insert({ calendarId, requestBody: eventBody });
    return `Event created: ${res.data.summary} (ID: ${res.data.id})\n${formatEvent(res.data)}`;
  } catch (err) {
    return handleCalendarError(err);
  }
}

export async function updateEvent(
  calendarId: string,
  eventId: string,
  updates: {
    summary?: string;
    start?: string;
    end?: string;
    description?: string;
    location?: string;
  },
): Promise<string> {
  try {
    const cal = getCalendar();

    // Fetch existing event first to merge updates
    const existing = await cal.events.get({ calendarId, eventId });
    const event = existing.data;

    if (updates.summary) event.summary = updates.summary;
    if (updates.start) event.start = { dateTime: updates.start };
    if (updates.end) event.end = { dateTime: updates.end };
    if (updates.description !== undefined) event.description = updates.description;
    if (updates.location !== undefined) event.location = updates.location;

    const res = await cal.events.update({
      calendarId,
      eventId,
      requestBody: event,
    });

    return `Event updated: ${res.data.summary} (ID: ${res.data.id})\n${formatEvent(res.data)}`;
  } catch (err) {
    return handleCalendarError(err);
  }
}

export async function deleteEvent(calendarId: string, eventId: string): Promise<string> {
  try {
    const cal = getCalendar();
    await cal.events.delete({ calendarId, eventId });
    return `Event deleted: ${eventId}`;
  } catch (err) {
    return handleCalendarError(err);
  }
}

export async function findFreeTime(
  calendarId: string,
  timeMin: string,
  timeMax: string,
): Promise<string> {
  try {
    const cal = getCalendar();
    const res = await cal.freebusy.query({
      requestBody: {
        timeMin,
        timeMax,
        items: [{ id: calendarId }],
      },
    });

    const busy = res.data.calendars?.[calendarId]?.busy ?? [];
    if (busy.length === 0) return `Completely free from ${timeMin} to ${timeMax}.`;

    const busyLines = busy.map((b) => {
      const start = b.start ? new Date(b.start).toLocaleString('en-US', {
        hour: 'numeric', minute: '2-digit',
      }) : 'unknown';
      const end = b.end ? new Date(b.end).toLocaleString('en-US', {
        hour: 'numeric', minute: '2-digit',
      }) : 'unknown';
      return `  Busy: ${start} – ${end}`;
    });

    // Calculate free slots between busy periods
    const freeSlots: string[] = [];
    const dayStart = new Date(timeMin);
    const dayEnd = new Date(timeMax);

    let cursor = dayStart;
    for (const b of busy) {
      const busyStart = new Date(b.start!);
      if (cursor < busyStart) {
        const freeStart = cursor.toLocaleString('en-US', { hour: 'numeric', minute: '2-digit' });
        const freeEnd = busyStart.toLocaleString('en-US', { hour: 'numeric', minute: '2-digit' });
        freeSlots.push(`  Free: ${freeStart} – ${freeEnd}`);
      }
      cursor = new Date(b.end!);
    }
    if (cursor < dayEnd) {
      const freeStart = cursor.toLocaleString('en-US', { hour: 'numeric', minute: '2-digit' });
      const freeEnd = dayEnd.toLocaleString('en-US', { hour: 'numeric', minute: '2-digit' });
      freeSlots.push(`  Free: ${freeStart} – ${freeEnd}`);
    }

    return [
      `Schedule for ${timeMin.slice(0, 10)}:`,
      '',
      'Busy periods:',
      ...busyLines,
      '',
      'Free slots:',
      ...freeSlots,
    ].join('\n');
  } catch (err) {
    return handleCalendarError(err);
  }
}

/**
 * Returns upcoming events within the given time range as structured data.
 * Used by CalendarMonitor for proactive alerts.
 */
export async function getUpcomingEvents(
  calendarId: string,
  timeMin: string,
  timeMax: string,
): Promise<calendar_v3.Schema$Event[]> {
  const cal = getCalendar();
  const res = await cal.events.list({
    calendarId,
    timeMin,
    timeMax,
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: 20,
  });
  return res.data.items ?? [];
}
