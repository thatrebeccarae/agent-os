import type { calendar_v3 } from '@googleapis/calendar';
import { getUpcomingEvents } from '../calendar/client.js';

const POLL_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const ALERT_WINDOW_MS = 30 * 60 * 1000;  // alert for events within 30 minutes
const MORNING_DIGEST_HOUR = 7;

export class CalendarMonitor {
  private pollIntervalId: ReturnType<typeof setInterval> | null = null;
  private digestIntervalId: ReturnType<typeof setInterval> | null = null;
  private alertedEventIds = new Set<string>();
  private lastDigestDate: string | null = null;
  private sendAlert: (message: string) => Promise<void>;
  private lastCheckAt: Date | null = null;

  constructor(sendAlert: (message: string) => Promise<void>) {
    this.sendAlert = sendAlert;
  }

  start(): void {
    if (this.pollIntervalId) return;

    this.pollIntervalId = setInterval(() => void this.checkUpcoming(), POLL_INTERVAL_MS);
    // Check for morning digest every minute
    this.digestIntervalId = setInterval(() => void this.checkMorningDigest(), 60 * 1000);

    // First check after a short delay
    setTimeout(() => void this.checkUpcoming(), 20_000);
    console.log('[calendar] Monitor started (poll: 15min, digest: 7:00 AM)');
  }

  stop(): void {
    if (this.pollIntervalId) {
      clearInterval(this.pollIntervalId);
      this.pollIntervalId = null;
    }
    if (this.digestIntervalId) {
      clearInterval(this.digestIntervalId);
      this.digestIntervalId = null;
    }
    console.log('[calendar] Monitor stopped');
  }

  getLastCheckTime(): Date | null {
    return this.lastCheckAt;
  }

  async checkUpcoming(): Promise<void> {
    this.lastCheckAt = new Date();
    try {
      const now = new Date();
      const ahead = new Date(now.getTime() + ALERT_WINDOW_MS);

      const events = await getUpcomingEvents(
        'primary',
        now.toISOString(),
        ahead.toISOString(),
      );

      for (const event of events) {
        if (!event.id || this.alertedEventIds.has(event.id)) continue;
        // Skip all-day events for upcoming alerts
        if (event.start?.date) continue;
        if (!event.start?.dateTime) continue;

        const startTime = new Date(event.start.dateTime);
        const minutesUntil = Math.round((startTime.getTime() - now.getTime()) / 60_000);

        if (minutesUntil <= 30 && minutesUntil >= 0) {
          this.alertedEventIds.add(event.id);
          const alert = this.formatUpcomingAlert(event, minutesUntil);
          await this.sendAlert(alert);
        }
      }

      // Prune old alerted IDs (keep last 100)
      if (this.alertedEventIds.size > 100) {
        const entries = [...this.alertedEventIds];
        this.alertedEventIds = new Set(entries.slice(-50));
      }
    } catch (err) {
      console.error('[calendar] Error checking upcoming events:', err instanceof Error ? err.message : err);
    }
  }

  private formatUpcomingAlert(event: calendar_v3.Schema$Event, minutesUntil: number): string {
    const lines: string[] = [];
    const timeStr = minutesUntil <= 1 ? 'starting now' : `in ${minutesUntil} minutes`;

    lines.push(`\u{1F4C5} Upcoming: ${event.summary ?? '(no title)'} ${timeStr}`);

    if (event.location) lines.push(`Where: ${event.location}`);
    if (event.hangoutLink) lines.push(`Meet: ${event.hangoutLink}`);

    if (event.attendees && event.attendees.length > 0) {
      const names = event.attendees
        .filter((a) => !a.self)
        .map((a) => a.displayName ?? a.email)
        .slice(0, 5);
      if (names.length > 0) lines.push(`With: ${names.join(', ')}`);
    }

    return lines.join('\n');
  }

  async checkMorningDigest(): Promise<void> {
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);

    // Only send once per day, at the digest hour
    if (now.getHours() !== MORNING_DIGEST_HOUR) return;
    if (this.lastDigestDate === todayStr) return;

    this.lastDigestDate = todayStr;

    try {
      const dayStart = new Date(`${todayStr}T00:00:00`);
      const dayEnd = new Date(`${todayStr}T23:59:59`);

      const events = await getUpcomingEvents(
        'primary',
        dayStart.toISOString(),
        dayEnd.toISOString(),
      );

      if (events.length === 0) {
        await this.sendAlert(`\u{1F4C5} Today's schedule: No events. Enjoy the free day!`);
        return;
      }

      const lines: string[] = [`\u{1F4C5} Today's schedule (${events.length} event${events.length > 1 ? 's' : ''}):`];

      for (const event of events) {
        let timeStr: string;
        if (event.start?.date) {
          timeStr = 'All day';
        } else if (event.start?.dateTime) {
          const start = new Date(event.start.dateTime);
          timeStr = start.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
          if (event.end?.dateTime) {
            const end = new Date(event.end.dateTime);
            timeStr += ` – ${end.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
          }
        } else {
          timeStr = 'unknown time';
        }

        let line = `  ${timeStr}: ${event.summary ?? '(no title)'}`;
        if (event.location) line += ` @ ${event.location}`;
        lines.push(line);
      }

      await this.sendAlert(lines.join('\n'));
    } catch (err) {
      console.error('[calendar] Error sending morning digest:', err instanceof Error ? err.message : err);
    }
  }
}
