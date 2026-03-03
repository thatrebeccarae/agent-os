// ---------------------------------------------------------------------------
// Channel abstraction — common types for all messaging platforms
// ---------------------------------------------------------------------------

export interface InboundMessage {
  channelType: 'telegram' | 'slack';
  channelId: string;       // e.g. telegram chat ID
  senderId: string;        // user identifier
  senderName: string;      // display name
  text: string;
  timestamp: number;       // unix ms
  raw?: unknown;           // original platform message
}

export interface OutboundMessage {
  channelType: string;
  channelId: string;
  text: string;
  replyToId?: string;
}

export interface ChannelAdapter {
  type: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  sendMessage(msg: OutboundMessage): Promise<void>;
  onMessage(handler: (msg: InboundMessage) => Promise<void>): void;
}
