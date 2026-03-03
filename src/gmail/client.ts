import { gmail, type gmail_v1 } from '@googleapis/gmail';
import { getOAuth2Client } from './auth.js';
import { wrapAndDetect } from '../security/content-boundary.js';
import { handleGoogleApiError } from '../google/errors.js';

const MAX_BODY_CHARS = 10_000;
const MAX_THREAD_MSG_CHARS = 2_000;
const MAX_THREAD_MESSAGES = 25;
const MAX_DECODE_DEPTH = 10;

function getGmail(): gmail_v1.Gmail {
  return gmail({ version: 'v1', auth: getOAuth2Client() });
}

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_m, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function getHeader(headers: gmail_v1.Schema$MessagePartHeader[] | undefined, name: string): string {
  return headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? '';
}

function decodeBody(part: gmail_v1.Schema$MessagePart | undefined, depth = 0): string {
  if (!part || depth > MAX_DECODE_DEPTH) return '';

  // If this part has a body with data, decode it
  if (part.body?.data) {
    return Buffer.from(part.body.data, 'base64url').toString('utf-8');
  }

  // Multipart: prefer text/plain, fall back to text/html
  if (part.parts) {
    const textPart = part.parts.find((p) => p.mimeType === 'text/plain');
    if (textPart?.body?.data) {
      return Buffer.from(textPart.body.data, 'base64url').toString('utf-8');
    }
    const htmlPart = part.parts.find((p) => p.mimeType === 'text/html');
    if (htmlPart?.body?.data) {
      return stripHtml(Buffer.from(htmlPart.body.data, 'base64url').toString('utf-8'));
    }
    // Nested multipart (e.g. multipart/alternative inside multipart/mixed)
    for (const sub of part.parts) {
      const result = decodeBody(sub, depth + 1);
      if (result) return result;
    }
  }

  return '';
}

function formatMessage(msg: gmail_v1.Schema$Message, maxChars: number): string {
  const headers = msg.payload?.headers;
  const from = getHeader(headers, 'From');
  const to = getHeader(headers, 'To');
  const subject = getHeader(headers, 'Subject');
  const date = getHeader(headers, 'Date');

  let body = decodeBody(msg.payload);
  if (body.length > maxChars) {
    body = body.slice(0, maxChars) + '\n[truncated]';
  }

  // Security: detect injection patterns and wrap external content
  body = wrapAndDetect(body, `email:${from}`);

  const labels = msg.labelIds?.join(', ') ?? 'none';

  return [
    `Message ID: ${msg.id}`,
    `Thread ID: ${msg.threadId}`,
    `From: ${from}`,
    `To: ${to}`,
    `Date: ${date}`,
    `Subject: ${subject}`,
    `Labels: ${labels}`,
    `Snippet: ${msg.snippet ?? ''}`,
    '',
    body,
  ].join('\n');
}

function handleGmailError(err: unknown): string {
  return handleGoogleApiError(err, 'Gmail');
}

/**
 * Fetches new message IDs added since the given historyId.
 * Uses the Gmail History API for efficient delta detection.
 * Returns an array of message IDs (may be empty).
 */
export async function listHistory(startHistoryId: string): Promise<string[]> {
  try {
    const gmail = getGmail();
    const messageIds: string[] = [];
    let pageToken: string | undefined;

    do {
      const res = await gmail.users.history.list({
        userId: 'me',
        startHistoryId,
        historyTypes: ['messageAdded'],
        pageToken,
      });

      const history = res.data.history ?? [];
      for (const record of history) {
        const added = record.messagesAdded ?? [];
        for (const item of added) {
          if (item.message?.id) {
            messageIds.push(item.message.id);
          }
        }
      }

      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);

    return messageIds;
  } catch (err) {
    // historyId too old — Gmail purges history after ~7 days
    if (err && typeof err === 'object' && 'code' in err && Number((err as { code: unknown }).code) === 404) {
      console.warn('[gmail] History ID expired — resetting. Will pick up new messages on next poll.');
      return [];
    }
    console.error('[gmail] Error fetching history:', err instanceof Error ? err.message : err);
    return [];
  }
}

export async function getProfile(): Promise<string> {
  try {
    const gmail = getGmail();
    const res = await gmail.users.getProfile({ userId: 'me' });
    return [
      `Email: ${res.data.emailAddress}`,
      `Total messages: ${res.data.messagesTotal}`,
      `Total threads: ${res.data.threadsTotal}`,
      `History ID: ${res.data.historyId}`,
    ].join('\n');
  } catch (err) {
    return handleGmailError(err);
  }
}

export async function listLabels(): Promise<string> {
  try {
    const gmail = getGmail();
    const res = await gmail.users.labels.list({ userId: 'me' });
    const labels = res.data.labels ?? [];

    // Fetch details — prioritize key system labels, then user labels
    const priorityIds = ['INBOX', 'UNREAD', 'STARRED', 'DRAFT', 'SENT', 'SPAM', 'TRASH'];
    const systemLabels = labels.filter((l) => l.id && priorityIds.includes(l.id));
    const categoryLabels = labels.filter((l) => l.id?.startsWith('CATEGORY_'));
    const userLabels = labels.filter((l) => l.type === 'user');

    const ordered = [...systemLabels, ...categoryLabels, ...userLabels];

    // Fetch all label details in parallel
    const results = await Promise.all(
      ordered.filter((l) => l.id).map(async (label) => {
        try {
          const detail = await gmail.users.labels.get({ userId: 'me', id: label.id! });
          const unread = detail.data.messagesUnread ?? 0;
          const total = detail.data.messagesTotal ?? 0;
          if (total > 0) {
            return `${detail.data.name}: ${total} messages (${unread} unread)`;
          }
          return null;
        } catch {
          return `${label.name}: (unable to fetch details)`;
        }
      }),
    );

    const details = results.filter((r): r is string => r !== null);
    return details.length > 0 ? details.join('\n') : 'No labels found.';
  } catch (err) {
    return handleGmailError(err);
  }
}

export async function searchMessages(query: string, maxResults = 10): Promise<string> {
  try {
    const gmail = getGmail();
    const res = await gmail.users.messages.list({
      userId: 'me',
      q: query,
      maxResults: Math.min(maxResults, 50),
    });

    const messages = res.data.messages ?? [];
    if (messages.length === 0) return `No messages found for query: ${query}`;

    // Fetch all message metadata in parallel
    const results = await Promise.all(
      messages.filter((m) => m.id).map(async (msg) => {
        const detail = await gmail.users.messages.get({
          userId: 'me',
          id: msg.id!,
          format: 'metadata',
          metadataHeaders: ['From', 'To', 'Subject', 'Date'],
        });
        const headers = detail.data.payload?.headers;
        return `[${msg.id}] ${getHeader(headers, 'Date')} | From: ${getHeader(headers, 'From')} | Subject: ${getHeader(headers, 'Subject')} | Snippet: ${detail.data.snippet ?? ''}`;
      }),
    );

    return `${messages.length} message(s) found:\n\n${results.join('\n')}`;
  } catch (err) {
    return handleGmailError(err);
  }
}

export async function readMessage(messageId: string): Promise<string> {
  try {
    const gmail = getGmail();
    const res = await gmail.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'full',
    });
    return formatMessage(res.data, MAX_BODY_CHARS);
  } catch (err) {
    return handleGmailError(err);
  }
}

export async function readThread(threadId: string): Promise<string> {
  try {
    const gmail = getGmail();
    const res = await gmail.users.threads.get({
      userId: 'me',
      id: threadId,
      format: 'full',
    });

    const allMessages = res.data.messages ?? [];
    if (allMessages.length === 0) return `Thread ${threadId} has no messages.`;

    const totalCount = allMessages.length;
    const messages = allMessages.slice(0, MAX_THREAD_MESSAGES);
    const truncated = totalCount > MAX_THREAD_MESSAGES;

    const parts = messages.map((msg, i) =>
      `--- Message ${i + 1} of ${totalCount} ---\n${formatMessage(msg, MAX_THREAD_MSG_CHARS)}`,
    );

    if (truncated) {
      parts.push(`\n[showing ${MAX_THREAD_MESSAGES} of ${totalCount} messages]`);
    }

    return parts.join('\n\n');
  } catch (err) {
    return handleGmailError(err);
  }
}

export async function createDraft(
  to: string,
  subject: string,
  body: string,
  replyToMessageId?: string,
): Promise<string> {
  try {
    const gmail = getGmail();

    // Build RFC 2822 message — strip newlines from subject to prevent header injection
    const safeSubject = subject.replace(/[\r\n]+/g, ' ');
    const lines = [
      `To: ${to}`,
      `Subject: ${safeSubject}`,
      'Content-Type: text/plain; charset=utf-8',
    ];

    let threadId: string | undefined;
    if (replyToMessageId) {
      // Fetch the original message to get threadId and Message-ID header
      const original = await gmail.users.messages.get({
        userId: 'me',
        id: replyToMessageId,
        format: 'metadata',
        metadataHeaders: ['Message-ID', 'Subject'],
      });
      threadId = original.data.threadId ?? undefined;
      const originalMessageId = getHeader(original.data.payload?.headers, 'Message-ID');
      if (originalMessageId) {
        lines.push(`In-Reply-To: ${originalMessageId}`);
        lines.push(`References: ${originalMessageId}`);
      }
    }

    lines.push('', body);
    const raw = Buffer.from(lines.join('\r\n')).toString('base64url');

    const res = await gmail.users.drafts.create({
      userId: 'me',
      requestBody: {
        message: {
          raw,
          threadId,
        },
      },
    });

    return `Draft created — ID: ${res.data.id}, Message ID: ${res.data.message?.id}`;
  } catch (err) {
    return handleGmailError(err);
  }
}

export async function archiveMessage(messageId: string): Promise<string> {
  try {
    const gmail = getGmail();
    await gmail.users.messages.modify({
      userId: 'me',
      id: messageId,
      requestBody: {
        removeLabelIds: ['INBOX'],
      },
    });
    return `Archived message ${messageId} (removed INBOX label).`;
  } catch (err) {
    return handleGmailError(err);
  }
}

export async function modifyLabels(
  messageId: string,
  addLabelIds: string[],
  removeLabelIds: string[],
): Promise<string> {
  try {
    const gmail = getGmail();
    await gmail.users.messages.modify({
      userId: 'me',
      id: messageId,
      requestBody: {
        addLabelIds,
        removeLabelIds,
      },
    });

    const parts: string[] = [];
    if (addLabelIds.length > 0) parts.push(`Added: ${addLabelIds.join(', ')}`);
    if (removeLabelIds.length > 0) parts.push(`Removed: ${removeLabelIds.join(', ')}`);
    return `Labels updated for message ${messageId}. ${parts.join('. ')}`;
  } catch (err) {
    return handleGmailError(err);
  }
}
