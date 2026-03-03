import { gmail } from '@googleapis/gmail';
import { getOAuth2Client } from '../gmail/auth.js';
import { listHistory } from '../gmail/client.js';
import { searchMessages, listLabels } from '../gmail/client.js';
import type { AgentStore } from '../memory/store.js';
import type { TaskQueue } from '../tasks/queue.js';
import { getOwnerSessionId } from './config.js';
import { wrapExternalContent } from '../security/content-boundary.js';
import { OPERATOR_NAME } from '../config/identity.js';

const POLL_INTERVAL_MS = 30 * 60 * 1000;  // 30 minutes
const DIGEST_INTERVAL_MS = 2 * 60 * 60 * 1000; // 2 hours
const MAX_SEEN_IDS = 200;

export class InboxMonitor {
  private pollIntervalId: ReturnType<typeof setInterval> | null = null;
  private digestIntervalId: ReturnType<typeof setInterval> | null = null;
  private store: AgentStore;
  private taskQueue: TaskQueue;
  private sendAlert: (message: string) => Promise<void>;
  private lastCheckAt: Date | null = null;

  constructor(opts: {
    store: AgentStore;
    taskQueue: TaskQueue;
    sendAlert: (message: string) => Promise<void>;
  }) {
    this.store = opts.store;
    this.taskQueue = opts.taskQueue;
    this.sendAlert = opts.sendAlert;
  }

  start(): void {
    if (this.pollIntervalId) return;

    this.pollIntervalId = setInterval(() => void this.checkInbox(), POLL_INTERVAL_MS);
    this.digestIntervalId = setInterval(() => void this.sendDigest(), DIGEST_INTERVAL_MS);

    // First check after a short delay
    setTimeout(() => void this.checkInbox(), 15_000);

    console.log(`[inbox] Monitor started (poll: 30min, digest: 2h)`);
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
    console.log('[inbox] Monitor stopped');
  }

  getLastCheckTime(): Date | null {
    return this.lastCheckAt;
  }

  async checkInbox(): Promise<void> {
    this.lastCheckAt = new Date();
    try {
      const gmailClient = gmail({ version: 'v1', auth: getOAuth2Client() });

      // Get current profile for historyId
      const profile = await gmailClient.users.getProfile({ userId: 'me' });
      const currentHistoryId = profile.data.historyId;
      if (!currentHistoryId) return;

      const lastHistoryId = this.store.getInboxState('last_history_id');

      // First run — seed the historyId without alerting
      if (!lastHistoryId) {
        this.store.setInboxState('last_history_id', currentHistoryId);
        console.log(`[inbox] Seeded historyId: ${currentHistoryId}`);
        return;
      }

      // No changes since last check
      if (lastHistoryId === currentHistoryId) return;

      // Get new message IDs via History API
      const newMessageIds = await listHistory(lastHistoryId);

      // Filter out already-seen IDs
      const seenRaw = this.store.getInboxState('seen_message_ids');
      let seenIds: string[] = [];
      if (seenRaw) {
        try {
          seenIds = JSON.parse(seenRaw);
        } catch {
          console.warn('[inbox] Failed to parse seen_message_ids, resetting');
          seenIds = [];
        }
      }
      const seenSet = new Set(seenIds);
      const unseenIds = newMessageIds.filter((id) => !seenSet.has(id));

      // Update historyId regardless
      this.store.setInboxState('last_history_id', currentHistoryId);

      if (unseenIds.length === 0) return;

      // Fetch metadata for new messages
      const metadataList = await Promise.all(
        unseenIds.slice(0, 10).map(async (msgId) => {
          try {
            const detail = await gmailClient.users.messages.get({
              userId: 'me',
              id: msgId,
              format: 'metadata',
              metadataHeaders: ['From', 'Subject', 'Date'],
            });
            const headers = detail.data.payload?.headers;
            const from = headers?.find((h) => h.name?.toLowerCase() === 'from')?.value ?? 'unknown';
            const subject = headers?.find((h) => h.name?.toLowerCase() === 'subject')?.value ?? '(no subject)';
            const snippet = detail.data.snippet ?? '';
            return { from, subject, snippet };
          } catch {
            return null;
          }
        }),
      );

      const validMeta = metadataList.filter((m): m is NonNullable<typeof m> => m !== null);

      if (validMeta.length > 0) {
        // Create a triage task for the agent
        const ownerSessionId = getOwnerSessionId();
        const messageList = validMeta
          .map((m) => `- From: ${m.from}\n  Subject: ${m.subject}\n  Preview: ${m.snippet.slice(0, 100)}`)
          .join('\n');

        const wrappedMessageList = wrapExternalContent(messageList, 'email_triage');

        const description =
          `${validMeta.length} new email(s) detected. Triage for importance and alert ${OPERATOR_NAME} if anything needs attention.\n\n` +
          `Messages:\n${wrappedMessageList}\n\n` +
          `If nothing is urgent, respond briefly with "No urgent emails." Otherwise, summarize what needs attention.`;

        this.taskQueue.createTask({
          title: 'Inbox triage: new messages detected',
          description,
          tier: 'capable',
          source: 'system',
          sessionId: ownerSessionId ?? undefined,
        });

        console.log(`[inbox] Created triage task for ${validMeta.length} new message(s)`);
      }

      // Update seen IDs (rolling window)
      const updatedSeen = [...seenIds, ...unseenIds].slice(-MAX_SEEN_IDS);
      this.store.setInboxState('seen_message_ids', JSON.stringify(updatedSeen));
    } catch (err) {
      console.error('[inbox] Error checking inbox:', err instanceof Error ? err.message : err);
    }
  }

  async sendDigest(): Promise<void> {
    try {
      // Get unread counts via label info
      const labelInfo = await listLabels();

      // Get top unreads (skip promotions)
      const unreadsInfo = await searchMessages('in:inbox is:unread -category:promotions', 10);

      const lines = [
        '📬 Inbox Digest',
        '',
        labelInfo
          .split('\n')
          .filter((l) => l.includes('unread'))
          .slice(0, 5)
          .join('\n') || 'No unread summary available.',
        '',
        'Top unread:',
        unreadsInfo.startsWith('No messages')
          ? 'Inbox zero! 🎉'
          : unreadsInfo
              .split('\n')
              .slice(1, 6) // skip the "N message(s) found:" header, take top 5
              .join('\n') || 'None',
      ];

      const message = lines.join('\n');

      await this.sendAlert(message);
      this.store.setInboxState('last_digest_at', new Date().toISOString());

      console.log('[inbox] Digest sent');
    } catch (err) {
      console.error('[inbox] Error sending digest:', err instanceof Error ? err.message : err);
    }
  }
}
