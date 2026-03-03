/**
 * HeartbeatMonitor — periodic self-review of Agent state.
 * Uses cheap LLM tier, skips call entirely if nothing changed.
 */

import type { LLMRouter } from '../llm/router.js';
import type { TaskQueue } from '../tasks/queue.js';
import { collectState } from './state.js';
import type { HeartbeatState } from './state.js';
import { AGENT_NAME } from '../config/identity.js';

// --- Config ---

export function isHeartbeatEnabled(): boolean {
  return process.env.HEARTBEAT_ENABLED !== 'false';
}

function getHeartbeatInterval(): number {
  return Number(process.env.HEARTBEAT_INTERVAL_MS) || 30 * 60 * 1000; // 30 min default
}

// --- Heartbeat logic ---

const SYSTEM_PROMPT = `You are an internal heartbeat monitor for ${AGENT_NAME}, a personal AI assistant. Be extremely conservative — only act on genuinely important situations.`;

function buildPrompt(state: HeartbeatState): string {
  return `You are ${AGENT_NAME}'s internal heartbeat. Review this state and decide if any action is needed.

Current state:
${JSON.stringify(state, null, 2)}

Respond with ONE of:
- "NO_ACTION" — nothing needs attention
- "ALERT: <message>" — send this alert to the owner via Telegram
- "TASK: <title> | <description>" — create a background task to handle something

Be extremely conservative. Only alert or create tasks for genuinely important situations:
- Tasks stuck in "running" for over 30 minutes
- Multiple failed tasks in the last hour
- Claude Code session running for over 2 hours
- No user interaction in 24+ hours (check-in message)

Do NOT alert for normal operations. When in doubt, respond NO_ACTION.`;
}

interface PreviousSnapshot {
  pendingTasks: number;
  runningTasks: number;
  failedTasksRecent: number;
  activeClaudeCode: boolean;
  factCount: number;
  lastUserSessionId: string | null;
}

function snapshotKey(state: HeartbeatState): PreviousSnapshot {
  return {
    pendingTasks: state.pendingTasks,
    runningTasks: state.runningTasks,
    failedTasksRecent: state.failedTasksRecent,
    activeClaudeCode: state.activeClaudeCode !== null,
    factCount: state.recentFacts.length,
    lastUserSessionId: state.lastUserMessage?.sessionId ?? null,
  };
}

function hasChanged(prev: PreviousSnapshot | null, current: PreviousSnapshot): boolean {
  if (!prev) return true;
  return (
    prev.pendingTasks !== current.pendingTasks ||
    prev.runningTasks !== current.runningTasks ||
    prev.failedTasksRecent !== current.failedTasksRecent ||
    prev.activeClaudeCode !== current.activeClaudeCode ||
    prev.factCount !== current.factCount ||
    prev.lastUserSessionId !== current.lastUserSessionId
  );
}

export interface HeartbeatResult {
  action: 'no_action' | 'alert' | 'task' | 'skipped' | 'error';
  message?: string;
  timestamp: string;
}

// --- Monitor class ---

export class HeartbeatMonitor {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private initialTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private router: LLMRouter;
  private sendAlert: (message: string) => Promise<void>;
  private taskQueue: TaskQueue;
  private previousSnapshot: PreviousSnapshot | null = null;
  private _lastResult: HeartbeatResult | null = null;

  constructor(opts: {
    router: LLMRouter;
    sendAlert: (message: string) => Promise<void>;
    taskQueue: TaskQueue;
  }) {
    this.router = opts.router;
    this.sendAlert = opts.sendAlert;
    this.taskQueue = opts.taskQueue;
  }

  start(): void {
    if (this.intervalId) return;
    const interval = getHeartbeatInterval();
    this.intervalId = setInterval(() => void this.pulse(), interval);
    // First pulse after 2 minutes (let other monitors initialize first)
    this.initialTimeoutId = setTimeout(() => void this.pulse(), 2 * 60 * 1000);
    console.log(`[heartbeat] Monitor started (interval: ${interval / 60_000}min)`);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    if (this.initialTimeoutId) {
      clearTimeout(this.initialTimeoutId);
      this.initialTimeoutId = null;
    }
    console.log('[heartbeat] Monitor stopped');
  }

  getLastResult(): HeartbeatResult | null {
    return this._lastResult;
  }

  private async pulse(): Promise<HeartbeatResult> {
    try {
      const state = collectState();
      const current = snapshotKey(state);

      if (!hasChanged(this.previousSnapshot, current)) {
        const result: HeartbeatResult = { action: 'skipped', timestamp: new Date().toISOString() };
        this._lastResult = result;
        console.log('[heartbeat] No material changes — skipped LLM call');
        return result;
      }

      this.previousSnapshot = current;

      const prompt = buildPrompt(state);
      const response = await this.router.call(
        [{ role: 'user', content: prompt }],
        SYSTEM_PROMPT,
        [],
        { tier: 'cheap' },
      );

      const text = response.content.filter((b) => b.type === 'text').map((b) => b.type === 'text' ? b.text : '').join('').trim();
      const result = await this.parseAndAct(text);
      this._lastResult = result;
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[heartbeat] Pulse error:', msg);
      const result: HeartbeatResult = { action: 'error', message: msg, timestamp: new Date().toISOString() };
      this._lastResult = result;
      return result;
    }
  }

  private async parseAndAct(text: string): Promise<HeartbeatResult> {
    const timestamp = new Date().toISOString();

    if (text.startsWith('NO_ACTION') || text === '') {
      console.log('[heartbeat] Pulse result: NO_ACTION');
      return { action: 'no_action', timestamp };
    }

    if (text.startsWith('ALERT:')) {
      const message = text.slice(6).trim();
      console.log(`[heartbeat] Pulse result: ALERT — ${message}`);
      try {
        await this.sendAlert(`[Heartbeat] ${message}`);
      } catch (err) {
        console.error('[heartbeat] Failed to send alert:', err);
      }
      return { action: 'alert', message, timestamp };
    }

    if (text.startsWith('TASK:')) {
      const body = text.slice(5).trim();
      const pipeIdx = body.indexOf('|');
      const title = pipeIdx >= 0 ? body.slice(0, pipeIdx).trim() : body;
      const description = pipeIdx >= 0 ? body.slice(pipeIdx + 1).trim() : '';

      console.log(`[heartbeat] Pulse result: TASK — ${title}`);
      this.taskQueue.createTask({
        title,
        description,
        tier: 'cheap',
        source: 'system',
      });
      return { action: 'task', message: title, timestamp };
    }

    console.log(`[heartbeat] Unrecognized response: ${text.slice(0, 100)}`);
    return { action: 'no_action', timestamp };
  }
}
