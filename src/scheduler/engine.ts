/**
 * SchedulerEngine — the timer loop that checks for due jobs and
 * enqueues them into the task queue for execution by the TaskWorker.
 *
 * Runs a single check every 60 seconds, claims all due jobs,
 * and creates tasks for them. Handles missed jobs on startup.
 */

import type { TaskQueue } from '../tasks/queue.js';
import type { SchedulerStore } from './store.js';
import type { ScheduledJob } from './types.js';

// ── Constants ──────────────────────────────────────────────────────

const TICK_INTERVAL_MS = 60_000;         // Check every 60s
const MAX_CATCHUP_JOBS = 3;              // Max missed jobs to run on startup
const TASK_TITLE_PREFIX = '[scheduled] ';

// ── SchedulerEngine ────────────────────────────────────────────────

export interface SchedulerEngineOptions {
  store: SchedulerStore;
  taskQueue: TaskQueue;
  notifyCallback: (sessionId: string, message: string) => Promise<void>;
}

export class SchedulerEngine {
  private schedulerStore: SchedulerStore;
  private taskQueue: TaskQueue;
  private notifyCallback: (sessionId: string, message: string) => Promise<void>;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(opts: SchedulerEngineOptions) {
    this.schedulerStore = opts.store;
    this.taskQueue = opts.taskQueue;
    this.notifyCallback = opts.notifyCallback;
  }

  /**
   * Start the timer loop. Catches up on missed jobs first.
   */
  start(): void {
    if (this.running) {
      console.warn('[scheduler-engine] Already running');
      return;
    }

    this.running = true;

    // Catch up on missed jobs from downtime
    this.catchUpMissedJobs();

    this.intervalHandle = setInterval(() => {
      void this.tick();
    }, TICK_INTERVAL_MS);

    const jobCount = this.schedulerStore.getActiveJobCount();
    console.log(`[scheduler-engine] Started (${jobCount} active job(s), tick every ${TICK_INTERVAL_MS / 1000}s)`);
  }

  /**
   * Stop the timer loop.
   */
  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    this.running = false;
    console.log('[scheduler-engine] Stopped');
  }

  /**
   * Single tick: find all due jobs and enqueue them.
   */
  async tick(): Promise<void> {
    try {
      const dueJobs = this.schedulerStore.getDueJobs();
      if (dueJobs.length === 0) return;

      for (const job of dueJobs) {
        await this.executeJob(job);
      }
    } catch (err) {
      console.error('[scheduler-engine] Tick error:', err instanceof Error ? err.message : err);
    }
  }

  /**
   * Execute a single job by creating a task in the queue.
   */
  private async executeJob(job: ScheduledJob): Promise<void> {
    const taskTitle = `${TASK_TITLE_PREFIX}${job.name}`;

    // Skip if a pending task with the same title already exists (dedup)
    if (this.taskQueue.hasPendingTask(taskTitle)) {
      console.log(`[scheduler-engine] Skipping "${job.name}" — pending task exists`);
      // Still advance next_run_at to avoid re-triggering
      this.schedulerStore.recordSuccess(job.jobId);
      return;
    }

    try {
      const task = this.taskQueue.createTask({
        title: taskTitle,
        description: job.payloadPrompt,
        priority: 0,
        tier: 'capable',
        source: 'schedule',
        sessionId: job.deliveryMode === 'announce' ? (job.deliveryTarget ?? undefined) : undefined,
        metadata: {
          scheduledJobId: job.jobId,
          goalId: job.goalId,
        },
      });

      console.log(`[scheduler-engine] Enqueued task #${task.id} for job "${job.name}"`);
      this.schedulerStore.recordSuccess(job.jobId);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[scheduler-engine] Failed to enqueue "${job.name}":`, errorMsg);
      this.schedulerStore.recordFailure(job.jobId, errorMsg);

      // Notify operator if job was auto-disabled
      const updated = this.schedulerStore.getJob(job.jobId);
      if (updated && updated.status === 'disabled' && job.deliveryTarget) {
        try {
          await this.notifyCallback(
            job.deliveryTarget,
            `Scheduled job "${job.name}" has been auto-disabled after ${updated.maxConsecutiveErrors} consecutive errors.\n\nLast error: ${errorMsg}`,
          );
        } catch {
          // Non-fatal
        }
      }
    }
  }

  /**
   * On startup, run missed jobs (up to MAX_CATCHUP_JOBS).
   * A job is "missed" if its next_run_at is in the past.
   */
  private catchUpMissedJobs(): void {
    const missed = this.schedulerStore.getDueJobs(Date.now());
    if (missed.length === 0) return;

    const toRun = missed.slice(0, MAX_CATCHUP_JOBS);
    const skipped = missed.length - toRun.length;

    console.log(
      `[scheduler-engine] Catching up on ${toRun.length} missed job(s)` +
        (skipped > 0 ? ` (${skipped} skipped)` : ''),
    );

    for (const job of toRun) {
      void this.executeJob(job);
    }

    // For skipped jobs, just advance their next_run_at
    for (const job of missed.slice(MAX_CATCHUP_JOBS)) {
      this.schedulerStore.recordSuccess(job.jobId);
      console.log(`[scheduler-engine] Skipped missed job "${job.name}" — advanced next run`);
    }
  }

  /**
   * Expose the store for tools to use.
   */
  getStore(): SchedulerStore {
    return this.schedulerStore;
  }

  get isRunning(): boolean {
    return this.running;
  }
}
