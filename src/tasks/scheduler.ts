/**
 * Scheduler — simple interval-based recurring task creator.
 *
 * For MVP, supports fixed intervals (every N ms) rather than full cron syntax.
 * Each job creates a task in the queue at its interval, which the TaskWorker
 * then picks up and executes.
 */

import type { TaskQueue } from './queue.js';
import type { CreateTaskOpts } from './types.js';

// ── Types ───────────────────────────────────────────────────────────

export interface RecurringJob {
  name: string;
  intervalMs: number;
  createTaskOpts: CreateTaskOpts;
  handle: ReturnType<typeof setInterval> | null;
  lastRun: number | null;
}

// ── Scheduler ───────────────────────────────────────────────────────

export class Scheduler {
  private queue: TaskQueue;
  private jobs = new Map<string, RecurringJob>();
  private running = false;

  constructor(queue: TaskQueue) {
    this.queue = queue;
  }

  /**
   * Register a recurring task that will be enqueued at a fixed interval.
   *
   * @param name       Unique job name (used for deduplication and logging)
   * @param intervalMs How often to create the task (in milliseconds)
   * @param createTaskOpts  Options passed to queue.createTask() each interval
   */
  addRecurringTask(
    name: string,
    intervalMs: number,
    createTaskOpts: CreateTaskOpts,
  ): void {
    if (this.jobs.has(name)) {
      console.warn(`[scheduler] Job "${name}" already registered — skipping`);
      return;
    }

    const job: RecurringJob = {
      name,
      intervalMs,
      createTaskOpts: {
        ...createTaskOpts,
        source: createTaskOpts.source ?? 'schedule',
      },
      handle: null,
      lastRun: null,
    };

    this.jobs.set(name, job);
    console.log(
      `[scheduler] Registered job "${name}" (every ${formatInterval(intervalMs)})`,
    );

    // If the scheduler is already running, start this job immediately
    if (this.running) {
      this.startJob(job);
    }
  }

  /**
   * Start all registered jobs.
   */
  start(): void {
    if (this.running) {
      console.warn('[scheduler] Already running');
      return;
    }

    this.running = true;
    console.log(`[scheduler] Starting ${this.jobs.size} job(s)`);

    for (const job of this.jobs.values()) {
      this.startJob(job);
    }
  }

  /**
   * Stop all running jobs.
   */
  stop(): void {
    if (!this.running) return;

    for (const job of this.jobs.values()) {
      this.stopJob(job);
    }

    this.running = false;
    console.log('[scheduler] Stopped');
  }

  // ── Internal ────────────────────────────────────────────────────

  private startJob(job: RecurringJob): void {
    if (job.handle) return;

    job.handle = setInterval(() => {
      this.enqueueJob(job);
    }, job.intervalMs);

    console.log(`[scheduler] Started job "${job.name}"`);
  }

  private stopJob(job: RecurringJob): void {
    if (job.handle) {
      clearInterval(job.handle);
      job.handle = null;
    }
  }

  private enqueueJob(job: RecurringJob): void {
    try {
      // Skip if a pending task with the same title already exists
      if (this.queue.hasPendingTask(job.createTaskOpts.title)) {
        console.log(
          `[scheduler] Skipping job "${job.name}" — pending task already exists`,
        );
        return;
      }

      const task = this.queue.createTask(job.createTaskOpts);
      job.lastRun = Date.now();
      console.log(
        `[scheduler] Enqueued task #${task.id} for job "${job.name}"`,
      );
    } catch (err) {
      console.error(
        `[scheduler] Failed to enqueue job "${job.name}":`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

function formatInterval(ms: number): string {
  if (ms < 60_000) return `${ms / 1_000}s`;
  if (ms < 3_600_000) return `${ms / 60_000}min`;
  if (ms < 86_400_000) return `${ms / 3_600_000}h`;
  return `${ms / 86_400_000}d`;
}
