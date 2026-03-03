/**
 * TaskWorker — background worker that polls the task queue and executes
 * tasks asynchronously using the agent loop pattern.
 *
 * Only runs one task at a time to keep things simple and predictable.
 * The notifyCallback is injected by the gateway to route results back
 * to the right channel/session.
 */

import type { LLMRouter } from '../llm/router.js';
import type { AgentStore } from '../memory/store.js';
import type { ModelTier } from '../llm/types.js';
import type { Task } from './types.js';
import type { TaskQueue } from './queue.js';
import { runAgentLoop } from '../agent/loop.js';
import { getToolDefinitions } from '../agent/tools.js';
import { AGENT_NAME } from '../config/identity.js';

// ── Worker Options ──────────────────────────────────────────────────

export interface TaskWorkerOptions {
  router: LLMRouter;
  store: AgentStore;
  queue: TaskQueue;
  notifyCallback: (sessionId: string, message: string) => Promise<void>;
}

// ── Constants ───────────────────────────────────────────────────────

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const TASK_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const RESULT_SUMMARY_MAX_CHARS = 500;

// ── TaskWorker ──────────────────────────────────────────────────────

export class TaskWorker {
  private router: LLMRouter;
  private store: AgentStore;
  private queue: TaskQueue;
  private notifyCallback: (sessionId: string, message: string) => Promise<void>;

  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private busy = false;

  constructor(options: TaskWorkerOptions) {
    this.router = options.router;
    this.store = options.store;
    this.queue = options.queue;
    this.notifyCallback = options.notifyCallback;
  }

  /**
   * Start polling the task queue at the given interval.
   */
  start(intervalMs: number = DEFAULT_POLL_INTERVAL_MS): void {
    if (this.intervalHandle) {
      console.warn('[worker] Already running — call stop() first');
      return;
    }

    console.log(`[worker] Starting task worker (poll every ${intervalMs}ms)`);
    this.intervalHandle = setInterval(() => {
      void this.tick();
    }, intervalMs);
  }

  /**
   * Stop polling.
   */
  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
      console.log('[worker] Stopped');
    }
  }

  /**
   * Single poll cycle: claim the next pending task and execute it.
   * Returns immediately if already busy with another task.
   */
  async tick(): Promise<void> {
    if (this.busy) return;

    let task: Task | null | undefined;
    try {
      task = this.queue.claimNextTask();
    } catch (err) {
      console.error('[worker] Failed to claim task:', err);
      return;
    }

    if (!task) return;

    this.busy = true;
    console.log(`[worker] Executing task #${task.id}: ${task.title}`);

    try {
      const result = await this.executeTask(task);

      this.queue.completeTask(task.id, result);

      if (task.sessionId) {
        const summary = result.length > RESULT_SUMMARY_MAX_CHARS
          ? result.slice(0, RESULT_SUMMARY_MAX_CHARS) + '...'
          : result;
        await this.notifyCallback(
          task.sessionId,
          `Task completed: ${task.title}\n\n${summary}`,
        );
      }

      console.log(`[worker] Task #${task.id} completed`);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);

      this.queue.failTask(task.id, errorMsg);

      if (task.sessionId) {
        try {
          await this.notifyCallback(
            task.sessionId,
            `Task failed: ${task.title}\n\nError: ${errorMsg}`,
          );
        } catch (notifyErr) {
          console.error('[worker] Failed to send failure notification:', notifyErr instanceof Error ? notifyErr.message : notifyErr);
        }
      }

      console.error(`[worker] Task #${task.id} failed:`, errorMsg);
    } finally {
      this.busy = false;
    }
  }

  /**
   * Execute a single task using the agent loop pattern with a timeout.
   */
  private async executeTask(task: Task): Promise<string> {
    const systemPrompt = [
      `You are ${AGENT_NAME} executing a background task.`,
      `Task: ${task.title}`,
      task.description ? `Description: ${task.description}` : '',
      '',
      'Complete this task and return a clear summary of the result.',
    ]
      .filter(Boolean)
      .join('\n');

    const userMessage = task.description ?? task.title;
    const tools = getToolDefinitions();
    const tier = (task.tier as ModelTier) || 'capable';

    // Race the agent loop against a timeout
    const agentPromise = runAgentLoop(
      this.router,
      userMessage,
      [], // no session history for background tasks
      systemPrompt,
      tools,
      tier,
    );

    let timeoutHandle: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new Error(`Task timed out after ${TASK_TIMEOUT_MS / 1000}s`)),
        TASK_TIMEOUT_MS,
      );
    });

    try {
      const result = await Promise.race([agentPromise, timeoutPromise]);
      return result.response;
    } finally {
      clearTimeout(timeoutHandle!);
    }
  }

  /**
   * Check if the worker is currently executing a task.
   */
  get isRunning(): boolean {
    return this.intervalHandle !== null;
  }

  /**
   * Check if the worker is currently busy with a task.
   */
  get isBusy(): boolean {
    return this.busy;
  }
}
