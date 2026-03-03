import type Database from 'better-sqlite3';
import type { Task, CreateTaskOpts, TaskStatus } from './types.js';

// ── Raw row shape from SQLite ───────────────────────────────────────

interface TaskRow {
  id: number;
  title: string;
  description: string | null;
  status: string;
  priority: number;
  tier: string;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  result: string | null;
  error: string | null;
  source: string;
  session_id: string | null;
  metadata: string | null;
}

function rowToTask(row: TaskRow): Task {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status as Task['status'],
    priority: row.priority,
    tier: row.tier,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    result: row.result,
    error: row.error,
    source: row.source,
    sessionId: row.session_id,
    metadata: row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : null,
  };
}

// ── TaskQueue ───────────────────────────────────────────────────────

export class TaskQueue {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.initSchema();
  }

  // ── Schema ──────────────────────────────────────────────────────

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        title        TEXT    NOT NULL,
        description  TEXT,
        status       TEXT    NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
        priority     INTEGER NOT NULL DEFAULT 0,
        tier         TEXT    NOT NULL DEFAULT 'cheap'
                     CHECK (tier IN ('local', 'cheap', 'capable', 'max')),
        created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
        started_at   TEXT,
        completed_at TEXT,
        result       TEXT,
        error        TEXT,
        source       TEXT    NOT NULL DEFAULT 'chat'
                     CHECK (source IN ('chat', 'webhook', 'schedule', 'system')),
        session_id   TEXT,
        metadata     TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_tasks_status_priority
        ON tasks(status, priority DESC);

      CREATE INDEX IF NOT EXISTS idx_tasks_session
        ON tasks(session_id);
    `);
  }

  // ── Create ──────────────────────────────────────────────────────

  createTask(opts: CreateTaskOpts): Task {
    const stmt = this.db.prepare(`
      INSERT INTO tasks (title, description, priority, tier, source, session_id, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      opts.title,
      opts.description ?? null,
      opts.priority ?? 0,
      opts.tier ?? 'cheap',
      opts.source ?? 'chat',
      opts.sessionId ?? null,
      opts.metadata ? JSON.stringify(opts.metadata) : null,
    );

    return this.getTask(Number(result.lastInsertRowid))!;
  }

  // ── Claim ───────────────────────────────────────────────────────

  claimNextTask(): Task | null {
    const claim = this.db.transaction(() => {
      const row = this.db
        .prepare(
          `SELECT * FROM tasks
           WHERE status = 'pending'
           ORDER BY priority DESC, created_at ASC
           LIMIT 1`,
        )
        .get() as TaskRow | undefined;

      if (!row) return null;

      this.db
        .prepare(
          `UPDATE tasks
           SET status = 'running', started_at = datetime('now')
           WHERE id = ?`,
        )
        .run(row.id);

      // Re-read to get the updated started_at value
      return this.db
        .prepare('SELECT * FROM tasks WHERE id = ?')
        .get(row.id) as TaskRow;
    });

    const row = claim();
    return row ? rowToTask(row) : null;
  }

  // ── Complete / Fail / Cancel ────────────────────────────────────

  completeTask(id: number, result: string): void {
    this.db
      .prepare(
        `UPDATE tasks
         SET status = 'completed', completed_at = datetime('now'), result = ?
         WHERE id = ?`,
      )
      .run(result, id);
  }

  failTask(id: number, error: string): void {
    this.db
      .prepare(
        `UPDATE tasks
         SET status = 'failed', completed_at = datetime('now'), error = ?
         WHERE id = ?`,
      )
      .run(error, id);
  }

  cancelTask(id: number): void {
    this.db
      .prepare(
        `UPDATE tasks
         SET status = 'cancelled', completed_at = datetime('now')
         WHERE id = ?`,
      )
      .run(id);
  }

  // ── Queries ─────────────────────────────────────────────────────

  getTask(id: number): Task | null {
    const row = this.db
      .prepare('SELECT * FROM tasks WHERE id = ?')
      .get(id) as TaskRow | undefined;

    return row ? rowToTask(row) : null;
  }

  listTasks(status?: TaskStatus, limit: number = 50): Task[] {
    if (status) {
      const rows = this.db
        .prepare(
          `SELECT * FROM tasks
           WHERE status = ?
           ORDER BY priority DESC, created_at DESC
           LIMIT ?`,
        )
        .all(status, limit) as TaskRow[];

      return rows.map(rowToTask);
    }

    const rows = this.db
      .prepare(
        `SELECT * FROM tasks
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(limit) as TaskRow[];

    return rows.map(rowToTask);
  }

  hasPendingTask(title: string): boolean {
    const row = this.db
      .prepare("SELECT 1 FROM tasks WHERE status = 'pending' AND title = ? LIMIT 1")
      .get(title) as Record<string, unknown> | undefined;

    return row !== undefined;
  }

  getPendingCount(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as count FROM tasks WHERE status = 'pending'")
      .get() as { count: number };

    return row.count;
  }

  // ── Maintenance ─────────────────────────────────────────────────

  /** Remove completed/failed tasks older than N days. Called by interval in index.ts. */
  cleanupOldTasks(olderThanDays: number): number {
    const result = this.db
      .prepare(
        `DELETE FROM tasks
         WHERE status IN ('completed', 'failed')
           AND completed_at < datetime('now', ? || ' days')`,
      )
      .run(`-${olderThanDays}`);

    return result.changes;
  }
}
