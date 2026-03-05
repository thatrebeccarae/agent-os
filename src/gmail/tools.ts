import type { Tool } from '../agent/tools.js';
import { isGmailConfigured, type AccountId } from './auth.js';
import {
  getProfile,
  listLabels,
  searchMessages,
  readMessage,
  readThread,
  createDraft,
  archiveMessage,
  modifyLabels,
} from './client.js';

const ACCOUNT_PROP = {
  type: 'string' as const,
  enum: ['primary', 'secondary'],
  description:
    'Which inbox. Default: primary (operator@example.com — personal/business). ' +
    'Use "secondary" for hello@example.com (inbound/public-facing).',
};

function acct(input: Record<string, unknown>): AccountId | undefined {
  const v = input.account as string | undefined;
  if (v === 'primary' || v === 'secondary') return v;
  return undefined; // defaults to primary in client
}

export function getGmailTools(): Tool[] {
  if (!isGmailConfigured()) return [];

  return [
    {
      name: 'gmail_get_profile',
      description: 'Get Gmail mailbox info — email address, message count, thread count.',
      input_schema: {
        type: 'object',
        properties: { account: ACCOUNT_PROP },
        required: [],
      },
      handler: async (input) => getProfile(acct(input)),
    },
    {
      name: 'gmail_list_labels',
      description:
        'List all Gmail labels with message counts and unread counts. ' +
        'Use this to get unread counts, total message counts, or understand mailbox organization. ' +
        'This is the right tool for "how many unread emails" questions — gmail_search only returns a page of results, not totals.',
      input_schema: {
        type: 'object',
        properties: { account: ACCOUNT_PROP },
        required: [],
      },
      handler: async (input) => listLabels(acct(input)),
    },
    {
      name: 'gmail_search',
      description:
        'Search Gmail using query syntax. Returns a page of matching messages (not a total count — use gmail_list_labels for counts). ' +
        'Examples: "is:unread", "from:jane@example.com", "subject:invoice after:2026/01/01", ' +
        '"in:inbox is:unread -category:promotions". Returns message IDs, subjects, senders, and snippets.',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Gmail search query' },
          max_results: {
            type: 'number',
            description: 'Max messages to return (default 10, max 50)',
          },
          account: ACCOUNT_PROP,
        },
        required: ['query'],
      },
      handler: async (input) =>
        searchMessages(input.query as string, (input.max_results as number) ?? 10, acct(input)),
    },
    {
      name: 'gmail_read',
      description:
        'Read a specific email message by ID. Returns full headers and body. ' +
        'To find a message first, call gmail_search with a query, then use the message_id from the results.',
      input_schema: {
        type: 'object',
        properties: {
          message_id: { type: 'string', description: 'Gmail message ID' },
          account: ACCOUNT_PROP,
        },
        required: ['message_id'],
      },
      handler: async (input) => readMessage(input.message_id as string, acct(input)),
    },
    {
      name: 'gmail_read_thread',
      description:
        'Read all messages in an email thread. Returns messages in order. ' +
        'Get thread IDs from gmail_read results.',
      input_schema: {
        type: 'object',
        properties: {
          thread_id: { type: 'string', description: 'Gmail thread ID' },
          account: ACCOUNT_PROP,
        },
        required: ['thread_id'],
      },
      handler: async (input) => readThread(input.thread_id as string, acct(input)),
    },
    {
      name: 'gmail_create_draft',
      description:
        'Create a draft email. Does NOT send — only saves as draft. ' +
        'Optionally reply to an existing message by providing reply_to_message_id.',
      input_schema: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Recipient email address' },
          subject: { type: 'string', description: 'Email subject line' },
          body: { type: 'string', description: 'Plain text email body' },
          reply_to_message_id: {
            type: 'string',
            description: 'Message ID to reply to (optional — threads the reply)',
          },
          account: ACCOUNT_PROP,
        },
        required: ['to', 'subject', 'body'],
      },
      handler: async (input) =>
        createDraft(
          input.to as string,
          input.subject as string,
          input.body as string,
          input.reply_to_message_id as string | undefined,
          acct(input),
        ),
    },
    {
      name: 'gmail_archive',
      description: 'Archive a message by removing the INBOX label. The message is NOT deleted.',
      input_schema: {
        type: 'object',
        properties: {
          message_id: { type: 'string', description: 'Gmail message ID to archive' },
          account: ACCOUNT_PROP,
        },
        required: ['message_id'],
      },
      handler: async (input) => archiveMessage(input.message_id as string, acct(input)),
    },
    {
      name: 'gmail_label',
      description:
        'Add or remove labels from a message. Use gmail_list_labels to see available labels. ' +
        'Common labels: INBOX, UNREAD, STARRED, IMPORTANT, SPAM, TRASH.',
      input_schema: {
        type: 'object',
        properties: {
          message_id: { type: 'string', description: 'Gmail message ID' },
          add_labels: {
            type: 'array',
            items: { type: 'string' },
            description: 'Label IDs to add (optional)',
          },
          remove_labels: {
            type: 'array',
            items: { type: 'string' },
            description: 'Label IDs to remove (optional)',
          },
          account: ACCOUNT_PROP,
        },
        required: ['message_id'],
      },
      handler: async (input) =>
        modifyLabels(
          input.message_id as string,
          (input.add_labels as string[]) ?? [],
          (input.remove_labels as string[]) ?? [],
          acct(input),
        ),
    },
  ];
}
