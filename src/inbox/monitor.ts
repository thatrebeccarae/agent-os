import { gmail } from '@googleapis/gmail';
import { getOAuth2Client, getConfiguredAccounts, type AccountId } from '../gmail/auth.js';
import { listHistory } from '../gmail/client.js';
import { searchMessages, listLabels } from '../gmail/client.js';
import type { AgentStore } from '../memory/store.js';
import type { TaskQueue } from '../tasks/queue.js';
import { getOwnerSessionId } from './config.js';
import { wrapExternalContent } from '../security/content-boundary.js';
import { OPERATOR_NAME, PRIMARY_EMAIL, SECONDARY_EMAIL } from '../config/identity.js';

const POLL_INTERVAL_MS = 30 * 60 * 1000;  // 30 minutes
const DIGEST_INTERVAL_MS = 2 * 60 * 60 * 1000; // 2 hours
const SPAM_SCAN_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_SEEN_IDS = 200;

/** High-signal keywords that indicate a spam-filtered message may be a false positive. */
const SPAM_RESCUE_KEYWORDS = [
  'interview', 'offer', 'meeting', 'schedule', 'calendar', 'invite',
  'invoice', 'payment', 'contract', 'proposal', 'follow up', 'following up',
  'next steps', 'opportunity', 'position', 'role', 'candidate',
  'speaking', 'conference', 'award', 'nomination',
];

const ACCOUNT_LABELS: Record<AccountId, string> = {
  primary: `${PRIMARY_EMAIL} (personal/business)`,
  secondary: `${SECONDARY_EMAIL} (inbound/public)`,
};

export class InboxMonitor {
  private pollIntervalId: ReturnType<typeof setInterval> | null = null;
  private digestIntervalId: ReturnType<typeof setInterval> | null = null;
  private spamScanIntervalId: ReturnType<typeof setInterval> | null = null;
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
    this.spamScanIntervalId = setInterval(() => void this.guardedSpamScan(), SPAM_SCAN_INTERVAL_MS);

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

    // Run spam scan on startup if it hasn't run in 24h
    const lastSpamScanRaw = this.store.getInboxState('last_spam_scan_at');
    const spamScanAge = lastSpamScanRaw ? now - new Date(lastSpamScanRaw).getTime() : Infinity;
    if (spamScanAge > SPAM_SCAN_INTERVAL_MS) {
      setTimeout(() => void this.scanSpamForFalsePositives(), 30_000);
    }

    console.log(`[inbox] Monitor started (poll: 30min, digest: 2h, spam scan: 24h, accounts: ${accounts.length})`);
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
    if (this.spamScanIntervalId) {
      clearInterval(this.spamScanIntervalId);
      this.spamScanIntervalId = null;
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

      // Fetch metadata for new messages (include message ID for reply drafting)
      const metadataList = await Promise.all(
        unseenIds.slice(0, 10).map(async (msgId) => {
          try {
            const detail = await gmailClient.users.messages.get({
              userId: 'me',
              id: msgId,
              format: 'metadata',
              metadataHeaders: ['From', 'To', 'Subject', 'Date'],
            });
            const headers = detail.data.payload?.headers;
            const from = headers?.find((h) => h.name?.toLowerCase() === 'from')?.value ?? 'unknown';
            const to = headers?.find((h) => h.name?.toLowerCase() === 'to')?.value ?? '';
            const subject = headers?.find((h) => h.name?.toLowerCase() === 'subject')?.value ?? '(no subject)';
            const snippet = detail.data.snippet ?? '';
            const labels = detail.data.labelIds ?? [];
            return { id: msgId, from, to, subject, snippet, labels };
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
          .map((m) => `- Message ID: ${m.id}\n  From: ${m.from}\n  To: ${m.to}\n  Subject: ${m.subject}\n  Labels: ${m.labels.join(', ')}\n  Preview: ${m.snippet.slice(0, 100)}`)
          .join('\n');

        const wrappedMessageList = wrapExternalContent(messageList, 'email_triage');

        const description =
          `${validMeta.length} new email(s) in ${label} (${account} account). Triage these emails and take action.\n\n` +
          `Messages:\n${wrappedMessageList}\n\n` +
          `## Triage Rules\n` +
          `- Newsletters, marketing, and notifications: SKIP. Never urgent.\n` +
          `- Google Drive/Docs access requests: SKIP.\n` +
          `- Automated notifications, receipts, shipping updates: SKIP unless there's a problem.\n` +
          `- Messages labeled SPAM: check if this looks like a real person (not bulk mail). If the sender appears legitimate ` +
          `and the subject suggests a real conversation (interview, meeting, follow-up, etc.), ALERT ${OPERATOR_NAME} ` +
          `that a potentially important email was caught by the spam filter. Include the sender, subject, and message ID.\n\n` +
          `## Actions (in priority order)\n\n` +
          `### 1. Alert ${OPERATOR_NAME} about urgent/time-sensitive items\n` +
          `- Your text response IS the alert — it gets delivered automatically. Just write what ${OPERATOR_NAME} needs to know.\n` +
          `- Bills/payments due, account issues, scheduling conflicts, or replies from real people that need ${OPERATOR_NAME}'s personal attention.\n` +
          `- Describe what the OTHER PARTY said or needs — ${OPERATOR_NAME} knows what they sent.\n` +
          `- Mention which account (${label}) the email arrived in.\n` +
          `- Keep alerts plain text — no emoji.\n\n` +
          `### 2. Draft replies for emails that need a response\n` +
          `- If someone is asking a question, requesting a meeting, following up, or otherwise expecting a reply — draft one.\n` +
          `- Use gmail_read to get the full message, then gmail_read_thread for context if it's part of a conversation.\n` +
          `- Create the draft using gmail_create_draft with account "primary" and from "${SECONDARY_EMAIL}". ` +
          `This drafts in the primary inbox (so threading works) but sends from the assistant address. ` +
          `Use the original message's Message ID as reply_to_message_id so it threads correctly.\n` +
          `- Match ${OPERATOR_NAME}'s conversational writing style: warm but direct, professional but not stiff. Study the thread for tone cues.\n` +
          `- ALWAYS sign the email as "Agent" — you are not ${OPERATOR_NAME}. Never sign as or impersonate ${OPERATOR_NAME}.\n` +
          `- NEVER use emoji in email subject lines or bodies.\n` +
          `- Keep subjects plain, professional, and concise.\n\n` +
          `### 3. If nothing needs attention\n` +
          `- Respond with "No urgent emails." Do NOT list what you skipped. Do NOT create any Gmail drafts for summaries or digests.`;

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

      // Triage task — Telegram alerts only, no Gmail drafts for digests
      const ownerSessionId = getOwnerSessionId();
      const wrappedMessages = wrapExternalContent(digestParts.join('\n\n'), 'email_digest');

      this.taskQueue.createTask({
        title: 'Inbox digest: actionable emails',
        description:
          `Review these unread emails and summarize ONLY items that need action or a response. Your text response gets delivered to ${OPERATOR_NAME} automatically.\n\n` +
          `${wrappedMessages}\n\n` +
          `Rules:\n` +
          `- Skip newsletters, marketing, automated notifications, Google Drive/Docs access requests.\n` +
          `- For each actionable item: which account it's in, who sent it, what they need, and any deadline.\n` +
          `- Summarize what the OTHER PARTY said — ${OPERATOR_NAME} knows what they sent.\n` +
          `- If nothing is truly actionable, respond "No emails need attention." — do NOT send a digest.\n` +
          `- Do NOT create Gmail drafts for digest summaries. Your response goes to Telegram automatically.\n` +
          `- No emoji. Use plain text labels: "ACTION NEEDED" / "FYI".\n` +
          `- Keep items to 2-3 lines max.\n` +
          `- Do NOT list every skipped email — just state the count (e.g., "Skipped 12 newsletters/notifications").`,
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

  /** Only run spam scan if enough time has passed since the last one. */
  private async guardedSpamScan(): Promise<void> {
    const lastScanRaw = this.store.getInboxState('last_spam_scan_at');
    if (lastScanRaw) {
      const elapsed = Date.now() - new Date(lastScanRaw).getTime();
      if (elapsed < SPAM_SCAN_INTERVAL_MS - 60_000) {
        console.log('[inbox] Spam scan skipped — too soon since last');
        return;
      }
    }
    await this.scanSpamForFalsePositives();
  }

  /**
   * Daily scan of spam folder for potential false positives.
   * Looks for messages from real people with high-signal subjects
   * (interview invitations, meeting requests, follow-ups, etc.)
   * that may have been incorrectly filtered.
   */
  async scanSpamForFalsePositives(): Promise<void> {
    try {
      const accounts = getConfiguredAccounts();
      const rescueCandidates: string[] = [];

      for (const account of accounts) {
        const label = ACCOUNT_LABELS[account] ?? account;
        const gmailClient = gmail({ version: 'v1', auth: getOAuth2Client(account) });

        // Search spam from the last 7 days
        const res = await gmailClient.users.messages.list({
          userId: 'me',
          q: 'in:spam newer_than:7d',
          maxResults: 30,
        });

        const messages = res.data.messages ?? [];
        if (messages.length === 0) continue;

        // Fetch metadata and check for high-signal content
        const candidates = await Promise.all(
          messages.filter((m) => m.id).map(async (msg) => {
            try {
              const detail = await gmailClient.users.messages.get({
                userId: 'me',
                id: msg.id!,
                format: 'metadata',
                metadataHeaders: ['From', 'Subject', 'Date'],
              });
              const headers = detail.data.payload?.headers;
              const from = headers?.find((h) => h.name?.toLowerCase() === 'from')?.value ?? '';
              const subject = headers?.find((h) => h.name?.toLowerCase() === 'subject')?.value ?? '';
              const date = headers?.find((h) => h.name?.toLowerCase() === 'date')?.value ?? '';

              // Skip obvious bulk mail patterns
              const fromLower = from.toLowerCase();
              if (fromLower.includes('noreply') || fromLower.includes('no-reply') ||
                  fromLower.includes('mailer-daemon') || fromLower.includes('postmaster')) {
                return null;
              }

              // Check if subject or sender matches high-signal keywords
              const combined = `${subject} ${from}`.toLowerCase();
              const matchedKeyword = SPAM_RESCUE_KEYWORDS.find((kw) => combined.includes(kw));
              if (!matchedKeyword) return null;

              return { id: msg.id!, from, subject, date, account: label, matchedKeyword };
            } catch {
              return null;
            }
          }),
        );

        const validCandidates = candidates.filter((c): c is NonNullable<typeof c> => c !== null);
        for (const c of validCandidates) {
          rescueCandidates.push(
            `- Account: ${c.account}\n  Message ID: ${c.id}\n  From: ${c.from}\n  Subject: ${c.subject}\n  Date: ${c.date}\n  Matched: "${c.matchedKeyword}"`,
          );
        }
      }

      this.store.setInboxState('last_spam_scan_at', new Date().toISOString());

      if (rescueCandidates.length === 0) {
        console.log('[inbox] Spam scan complete — no false positive candidates found');
        return;
      }

      // Create a triage task for the agent to evaluate these
      const ownerSessionId = getOwnerSessionId();
      const wrappedCandidates = wrapExternalContent(rescueCandidates.join('\n'), 'spam_scan');

      this.taskQueue.createTask({
        title: 'Spam scan: potential false positives',
        description:
          `Daily spam scan found ${rescueCandidates.length} message(s) that may be false positives. ` +
          `Review each one. Your text response gets delivered to ${OPERATOR_NAME} automatically — just describe any that appear to be from real people.\n\n` +
          `Candidates:\n${wrappedCandidates}\n\n` +
          `Rules:\n` +
          `- Use gmail_read (account as noted) to read the full message before deciding.\n` +
          `- If it looks like a real person reaching out (recruiter, colleague, business contact, etc.), ` +
          `alert ${OPERATOR_NAME} with the sender, subject, date, and a brief summary of what they want.\n` +
          `- If it's bulk mail that happened to match keywords, skip it.\n` +
          `- Do NOT move messages out of spam — just flag them for ${OPERATOR_NAME} to review.\n` +
          `- No emoji. Keep alerts concise.\n` +
          `- If none are genuine false positives, respond "No false positives found in spam."`,
        tier: 'capable',
        source: 'system',
        sessionId: ownerSessionId ?? undefined,
      });

      console.log(`[inbox] Spam scan found ${rescueCandidates.length} candidate(s) — triage task created`);
    } catch (err) {
      console.error('[inbox] Error scanning spam:', err instanceof Error ? err.message : err);
    }
  }
}
