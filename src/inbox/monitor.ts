import { gmail } from '@googleapis/gmail';
import { getOAuth2Client, getConfiguredAccounts, type AccountId } from '../gmail/auth.js';
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

const ACCOUNT_LABELS: Record<AccountId, string> = {
  primary: 'rebecca@ (personal/business)',
  secondary: 'hi@ (inbound/public)',
};

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

    const accounts = getConfiguredAccounts();
    console.log(`[inbox] Configured accounts: ${accounts.join(', ')}`);

    this.pollIntervalId = setInterval(() => void this.checkAllAccounts(), POLL_INTERVAL_MS);
    this.digestIntervalId = setInterval(() => void this.guardedDigest(), DIGEST_INTERVAL_MS);

    // First check after a short delay (but skip if we checked very recently — prevents dupes on rapid restarts)
    const lastCheckRaw = this.store.getInboxState('last_check_at');
    const recentThreshold = 5 * 60 * 1000; // 5 minutes
    const now = Date.now();

    const lastCheckAge = lastCheckRaw ? now - new Date(lastCheckRaw).getTime() : Infinity;
    if (lastCheckAge > recentThreshold) {
      setTimeout(() => void this.checkAllAccounts(), 15_000);
    } else {
      console.log('[inbox] Skipping startup check — last check was recent');
    }

    console.log(`[inbox] Monitor started (poll: 30min, digest: 2h, accounts: ${accounts.length})`);
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

  /** State key namespaced per account. */
  private stateKey(key: string, account: AccountId): string {
    return `${key}:${account}`;
  }

  /** Check all configured accounts in sequence. */
  private async checkAllAccounts(): Promise<void> {
    this.lastCheckAt = new Date();
    this.store.setInboxState('last_check_at', this.lastCheckAt.toISOString());

    for (const account of getConfiguredAccounts()) {
      await this.checkInbox(account);
    }
  }

  /** Only send digest if enough time has passed since the last one. */
  private async guardedDigest(): Promise<void> {
    const lastDigestRaw = this.store.getInboxState('last_digest_at');
    if (lastDigestRaw) {
      const elapsed = Date.now() - new Date(lastDigestRaw).getTime();
      if (elapsed < DIGEST_INTERVAL_MS - 60_000) { // 1 min tolerance
        console.log('[inbox] Digest skipped — too soon since last');
        return;
      }
    }
    await this.sendDigest();
  }

  async checkInbox(account: AccountId): Promise<void> {
    try {
      const gmailClient = gmail({ version: 'v1', auth: getOAuth2Client(account) });
      const label = ACCOUNT_LABELS[account] ?? account;

      // Get current profile for historyId
      const profile = await gmailClient.users.getProfile({ userId: 'me' });
      const currentHistoryId = profile.data.historyId;
      if (!currentHistoryId) return;

      const lastHistoryId = this.store.getInboxState(this.stateKey('last_history_id', account));

      // First run — seed the historyId without alerting
      if (!lastHistoryId) {
        this.store.setInboxState(this.stateKey('last_history_id', account), currentHistoryId);
        console.log(`[inbox:${account}] Seeded historyId: ${currentHistoryId}`);
        return;
      }

      // No changes since last check
      if (lastHistoryId === currentHistoryId) return;

      // Get new message IDs via History API
      const newMessageIds = await listHistory(lastHistoryId, account);

      // Filter out already-seen IDs
      const seenRaw = this.store.getInboxState(this.stateKey('seen_message_ids', account));
      let seenIds: string[] = [];
      if (seenRaw) {
        try {
          seenIds = JSON.parse(seenRaw);
        } catch {
          console.warn(`[inbox:${account}] Failed to parse seen_message_ids, resetting`);
          seenIds = [];
        }
      }
      const seenSet = new Set(seenIds);
      const unseenIds = newMessageIds.filter((id) => !seenSet.has(id));

      // Update historyId regardless
      this.store.setInboxState(this.stateKey('last_history_id', account), currentHistoryId);

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
          `${validMeta.length} new email(s) in ${label} (${account} account). Triage for importance and alert ${OPERATOR_NAME} ONLY if something is actionable or time-sensitive.\n\n` +
          `Messages:\n${wrappedMessageList}\n\n` +
          `Rules:\n` +
          `- Newsletters, marketing, and notifications are NEVER urgent. Ignore them.\n` +
          `- Only alert for: replies from real people that need a response, bills/payments due, account issues, scheduling conflicts.\n` +
          `- When summarizing, describe what the OTHER PARTY said or needs — ${OPERATOR_NAME} already knows what they sent.\n` +
          `- Mention which account (${label}) the email arrived in.\n` +
          `- If nothing needs attention, respond with "No urgent emails." Do NOT list what you skipped.`;

        this.taskQueue.createTask({
          title: `Inbox triage: ${account} — new messages`,
          description,
          tier: 'capable',
          source: 'system',
          sessionId: ownerSessionId ?? undefined,
        });

        console.log(`[inbox:${account}] Created triage task for ${validMeta.length} new message(s)`);
      }

      // Update seen IDs (rolling window)
      const updatedSeen = [...seenIds, ...unseenIds].slice(-MAX_SEEN_IDS);
      this.store.setInboxState(this.stateKey('seen_message_ids', account), JSON.stringify(updatedSeen));
    } catch (err) {
      console.error(`[inbox:${account}] Error checking inbox:`, err instanceof Error ? err.message : err);
    }
  }

  async sendDigest(): Promise<void> {
    try {
      const accounts = getConfiguredAccounts();
      const digestParts: string[] = [];

      for (const account of accounts) {
        const label = ACCOUNT_LABELS[account] ?? account;
        // Only surface actionable emails — skip newsletters, promotions, notifications
        const unreadsInfo = await searchMessages(
          'in:inbox is:unread -category:promotions -category:updates -category:social -category:forums',
          10,
          account,
        );

        if (!unreadsInfo.startsWith('No messages')) {
          digestParts.push(`[${label}]\n${unreadsInfo}`);
        }
      }

      // Nothing actionable in any account — skip the digest entirely
      if (digestParts.length === 0) {
        console.log('[inbox] Digest skipped — no actionable unreads in any account');
        this.store.setInboxState('last_digest_at', new Date().toISOString());
        return;
      }

      // Create a triage task instead of raw-dumping to Telegram
      const ownerSessionId = getOwnerSessionId();
      const wrappedMessages = wrapExternalContent(digestParts.join('\n\n'), 'email_digest');

      this.taskQueue.createTask({
        title: 'Inbox digest: actionable emails',
        description:
          `Review these unread emails and send ${OPERATOR_NAME} a brief summary of ONLY items that need action or a response.\n\n` +
          `${wrappedMessages}\n\n` +
          `Rules:\n` +
          `- Skip newsletters, marketing, automated notifications.\n` +
          `- For each actionable item: which account it's in, who sent it, what they need, and any deadline.\n` +
          `- Summarize what the OTHER PARTY said — ${OPERATOR_NAME} knows what they sent.\n` +
          `- If nothing is truly actionable, respond "No emails need attention." — do NOT send a digest.`,
        tier: 'capable',
        source: 'system',
        sessionId: ownerSessionId ?? undefined,
      });

      this.store.setInboxState('last_digest_at', new Date().toISOString());
      console.log('[inbox] Digest task created');
    } catch (err) {
      console.error('[inbox] Error sending digest:', err instanceof Error ? err.message : err);
    }
  }
}
