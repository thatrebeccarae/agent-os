/**
 * SchedulerStore — SQLite persistence for scheduled jobs.
 *
 * Handles schema creation, CRUD, and query operations for the
 * scheduled_jobs table. Follows the same patterns as TaskQueue.
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type {
  ScheduledJob,
  ScheduledJobRow,
  CreateJobOpts,
  UpdateJobOpts,
  ApprovalStatus,
  JobStatus,
} from './types.js';
import { computeNextRun } from './schedule.js';

// ── Constants ──────────────────────────────────────────────────────

const MAX_ACTIVE_JOBS = 20;
const MIN_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_TIMEZONE = 'America/Los_Angeles';

// ── Row → Domain mapping ───────────────────────────────────────────

function rowToJob(row: ScheduledJobRow): ScheduledJob {
  return {
    jobId: row.job_id,
    name: row.name,
    scheduleType: row.schedule_type as ScheduledJob['scheduleType'],
    scheduleExpr: row.schedule_expr,
    timezone: row.timezone,
    payloadMode: row.payload_mode as ScheduledJob['payloadMode'],
    payloadPrompt: row.payload_prompt,
    deliveryMode: row.delivery_mode as ScheduledJob['deliveryMode'],
    deliveryTarget: row.delivery_target,
    enabled: row.enabled === 1,
    status: row.status as JobStatus,
    goalId: row.goal_id,
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    lastStatus: row.last_status,
    consecutiveErrors: row.consecutive_errors,
    maxConsecutiveErrors: row.max_consecutive_errors,
    approvalStatus: row.approval_status as ApprovalStatus,
    source: row.source as ScheduledJob['source'],
    createdAt: row.created_at,
  };
}

// ── SchedulerStore ─────────────────────────────────────────────────

export class SchedulerStore {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.initSchema();
  }

  // ── Schema ─────────────────────────────────────────────────────

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS scheduled_jobs (
        job_id                TEXT    PRIMARY KEY,
        name                  TEXT    NOT NULL,
        schedule_type         TEXT    NOT NULL CHECK (schedule_type IN ('at', 'every', 'cron')),
        schedule_expr         TEXT    NOT NULL,
        timezone              TEXT    NOT NULL DEFAULT 'America/Los_Angeles',
        payload_mode          TEXT    NOT NULL DEFAULT 'agentTurn'
                              CHECK (payload_mode IN ('systemEvent', 'agentTurn')),
        payload_prompt        TEXT    NOT NULL,
        delivery_mode         TEXT    NOT NULL DEFAULT 'announce'
                              CHECK (delivery_mode IN ('none', 'announce', 'webhook')),
        delivery_target       TEXT,
        enabled               INTEGER NOT NULL DEFAULT 1,
        status                TEXT    NOT NULL DEFAULT 'active'
                              CHECK (status IN ('active', 'paused', 'disabled', 'completed')),
        goal_id               TEXT,
        next_run_at           INTEGER NOT NULL,
        last_run_at           INTEGER,
        last_status           TEXT,
        consecutive_errors    INTEGER NOT NULL DEFAULT 0,
        max_consecutive_errors INTEGER NOT NULL DEFAULT 5,
        approval_status       TEXT    NOT NULL DEFAULT 'pending'
                              CHECK (approval_status IN ('pending', 'approved', 'denied')),
        source                TEXT    NOT NULL DEFAULT 'agent'
                              CHECK (source IN ('agent', 'system')),
        created_at            TEXT    NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_next_run
        ON scheduled_jobs(next_run_at) WHERE enabled = 1 AND status = 'active' AND approval_status = 'approved';

      CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_goal
        ON scheduled_jobs(goal_id) WHERE goal_id IS NOT NULL;
    `);
  }

  // ── Create ─────────────────────────────────────────────────────

  createJob(opts: CreateJobOpts): ScheduledJob {
    const isSystem = opts.source === 'system';

    // Enforce limits for agent-created jobs
    if (!isSystem) {
      const activeCount = this.getActiveJobCount();
      if (activeCount >= MAX_ACTIVE_JOBS) {
        throw new Error(`Maximum active jobs reached (${MAX_ACTIVE_JOBS}). Remove or disable existing jobs first.`);
      }

      // Validate minimum interval for recurring jobs
      if (opts.scheduleType === 'every') {
        const intervalMs = parseInt(opts.scheduleExpr, 10);
        if (isNaN(intervalMs) || intervalMs < MIN_INTERVAL_MS) {
          throw new Error(`Minimum interval is ${MIN_INTERVAL_MS / 60_000} minutes. Got: ${opts.scheduleExpr}`);
        }
      }
    }

    const jobId = randomUUID();
    const nextRunAt = computeNextRun(
      opts.scheduleType,
      opts.scheduleExpr,
      opts.timezone ?? DEFAULT_TIMEZONE,
    );

    const stmt = this.db.prepare(`
      INSERT INTO scheduled_jobs (
        job_id, name, schedule_type, schedule_expr, timezone,
        payload_mode, payload_prompt, delivery_mode, delivery_target,
        goal_id, next_run_at, max_consecutive_errors, approval_status, source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      jobId,
      opts.name,
      opts.scheduleType,
      opts.scheduleExpr,
      opts.timezone ?? DEFAULT_TIMEZONE,
      opts.payloadMode ?? 'agentTurn',
      opts.payloadPrompt,
      opts.deliveryMode ?? 'announce',
      opts.deliveryTarget ?? null,
      opts.goalId ?? null,
      nextRunAt,
      opts.maxConsecutiveErrors ?? 5,
      isSystem ? 'approved' : 'pending',  // system jobs pre-approved
      opts.source ?? 'agent',
    );

    return this.getJob(jobId)!;
  }

  // ── Read ───────────────────────────────────────────────────────

  getJob(jobId: string): ScheduledJob | null {
    const row = this.db
      .prepare('SELECT * FROM scheduled_jobs WHERE job_id = ?')
      .get(jobId) as ScheduledJobRow | undefined;
    return row ? rowToJob(row) : null;
  }

  getJobByName(name: string): ScheduledJob | null {
    const row = this.db
      .prepare('SELECT * FROM scheduled_jobs WHERE name = ?')
      .get(name) as ScheduledJobRow | undefined;
    return row ? rowToJob(row) : null;
  }

  listJobs(filter?: { status?: JobStatus; approvalStatus?: ApprovalStatus }): ScheduledJob[] {
    let sql = 'SELECT * FROM scheduled_jobs WHERE 1=1';
    const params: unknown[] = [];

    if (filter?.status) {
      sql += ' AND status = ?';
      params.push(filter.status);
    }
    if (filter?.approvalStatus) {
      sql += ' AND approval_status = ?';
      params.push(filter.approvalStatus);
    }

    sql += ' ORDER BY created_at ASC';

    const rows = this.db.prepare(sql).all(...params) as ScheduledJobRow[];
    return rows.map(rowToJob);
  }

  getDueJobs(nowMs: number = Date.now()): ScheduledJob[] {
    const rows = this.db
      .prepare(`
        SELECT * FROM scheduled_jobs
        WHERE enabled = 1
          AND status = 'active'
          AND approval_status = 'approved'
          AND next_run_at <= ?
        ORDER BY next_run_at ASC
      `)
      .all(nowMs) as ScheduledJobRow[];
    return rows.map(rowToJob);
  }

  getActiveJobCount(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as count FROM scheduled_jobs WHERE status = 'active'")
      .get() as { count: number };
    return row.count;
  }

  // ── Update ─────────────────────────────────────────────────────

  updateJob(jobId: string, opts: UpdateJobOpts): ScheduledJob | null {
    const existing = this.getJob(jobId);
    if (!existing) return null;

    const sets: string[] = [];
    const params: unknown[] = [];

    if (opts.name !== undefined) {
      sets.push('name = ?');
      params.push(opts.name);
    }
    if (opts.scheduleExpr !== undefined) {
      sets.push('schedule_expr = ?');
      params.push(opts.scheduleExpr);
      // Recompute next run
      const nextRun = computeNextRun(
        existing.scheduleType,
        opts.scheduleExpr,
        existing.timezone,
      );
      sets.push('next_run_at = ?');
      params.push(nextRun);
    }
    if (opts.payloadPrompt !== undefined) {
      sets.push('payload_prompt = ?');
      params.push(opts.payloadPrompt);
    }
    if (opts.deliveryMode !== undefined) {
      sets.push('delivery_mode = ?');
      params.push(opts.deliveryMode);
    }
    if (opts.deliveryTarget !== undefined) {
      sets.push('delivery_target = ?');
      params.push(opts.deliveryTarget);
    }
    if (opts.enabled !== undefined) {
      sets.push('enabled = ?');
      params.push(opts.enabled ? 1 : 0);
    }
    if (opts.maxConsecutiveErrors !== undefined) {
      sets.push('max_consecutive_errors = ?');
      params.push(opts.maxConsecutiveErrors);
    }

    if (sets.length === 0) return existing;

    params.push(jobId);
    this.db.prepare(`UPDATE scheduled_jobs SET ${sets.join(', ')} WHERE job_id = ?`).run(...params);
    return this.getJob(jobId);
  }

  approveJob(jobId: string): ScheduledJob | null {
    this.db
      .prepare("UPDATE scheduled_jobs SET approval_status = 'approved' WHERE job_id = ?")
      .run(jobId);
    return this.getJob(jobId);
  }

  denyJob(jobId: string): ScheduledJob | null {
    this.db
      .prepare("UPDATE scheduled_jobs SET approval_status = 'denied', status = 'disabled' WHERE job_id = ?")
      .run(jobId);
    return this.getJob(jobId);
  }

  // ── After execution ────────────────────────────────────────────

  recordSuccess(jobId: string): void {
    const job = this.getJob(jobId);
    if (!job) return;

    const now = Date.now();

    // One-shot jobs complete after execution
    if (job.scheduleType === 'at') {
      this.db
        .prepare(`
          UPDATE scheduled_jobs
          SET last_run_at = ?, last_status = 'success', consecutive_errors = 0, status = 'completed'
          WHERE job_id = ?
        `)
        .run(now, jobId);
      return;
    }

    // Recurring: compute next run
    const nextRun = computeNextRun(job.scheduleType, job.scheduleExpr, job.timezone);
    this.db
      .prepare(`
        UPDATE scheduled_jobs
        SET last_run_at = ?, last_status = 'success', consecutive_errors = 0, next_run_at = ?
        WHERE job_id = ?
      `)
      .run(now, nextRun, jobId);
  }

  recordFailure(jobId: string, error: string): void {
    const job = this.getJob(jobId);
    if (!job) return;

    const now = Date.now();
    const newErrors = job.consecutiveErrors + 1;
    const shouldDisable = newErrors >= job.maxConsecutiveErrors;

    if (job.scheduleType === 'at') {
      // One-shot jobs just fail
      this.db
        .prepare(`
          UPDATE scheduled_jobs
          SET last_run_at = ?, last_status = ?, consecutive_errors = ?, status = 'completed'
          WHERE job_id = ?
        `)
        .run(now, `error: ${error}`, newErrors, jobId);
      return;
    }

    // Recurring: compute next run with backoff
    const backoffMs = getBackoffMs(newErrors);
    const nextRun = now + backoffMs;

    this.db
      .prepare(`
        UPDATE scheduled_jobs
        SET last_run_at = ?, last_status = ?, consecutive_errors = ?,
            next_run_at = ?, status = ?, enabled = ?
        WHERE job_id = ?
      `)
      .run(
        now,
        `error: ${error}`,
        newErrors,
        nextRun,
        shouldDisable ? 'disabled' : 'active',
        shouldDisable ? 0 : 1,
        jobId,
      );
  }

  // ── Delete ─────────────────────────────────────────────────────

  removeJob(jobId: string): boolean {
    const result = this.db
      .prepare('DELETE FROM scheduled_jobs WHERE job_id = ?')
      .run(jobId);
    return result.changes > 0;
  }

  removeAllJobs(): number {
    const result = this.db
      .prepare("DELETE FROM scheduled_jobs WHERE source = 'agent'")
      .run();
    return result.changes;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function getBackoffMs(consecutiveErrors: number): number {
  // Exponential backoff: 30s, 1m, 5m, 15m, 60m
  const backoffs = [30_000, 60_000, 300_000, 900_000, 3_600_000];
  const idx = Math.min(consecutiveErrors - 1, backoffs.length - 1);
  return backoffs[Math.max(0, idx)];
}
