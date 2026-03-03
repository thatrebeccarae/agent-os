import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Types ──────────────────────────────────────────────────────────

export interface Session {
  id: string;
  created_at: number;
  updated_at: number;
}

export interface Message {
  id: number;
  session_id: string;
  role: 'user' | 'assistant' | 'tool_result';
  content: string;
  tool_name: string | null;
  timestamp: number;
}

export interface MemoryFact {
  id: number;
  fact: string;
  source_session: string;
  created_at: number;
  embedding: Buffer | null;
}

export interface MemorySearchResult {
  id: number;
  fact: string;
  source_session: string;
  created_at: number;
  rank: number;
}

// ── Store ──────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..', '..');
const DEFAULT_DB_PATH = resolve(PROJECT_ROOT, 'data', 'agent.db');

export class AgentStore {
  readonly db: Database.Database;

  constructor(dbPath: string = DEFAULT_DB_PATH) {
    // Ensure the directory exists
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);

    // Performance pragmas
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');

    this.initSchema();
  }

  // ── Schema ─────────────────────────────────────────────────────

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id         TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
      );

      CREATE TABLE IF NOT EXISTS messages (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT    NOT NULL REFERENCES sessions(id),
        role       TEXT    NOT NULL CHECK (role IN ('user', 'assistant', 'tool_result')),
        content    TEXT    NOT NULL,
        tool_name  TEXT,
        timestamp  INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
      );

      CREATE INDEX IF NOT EXISTS idx_messages_session
        ON messages(session_id, timestamp);

      CREATE TABLE IF NOT EXISTS memory_facts (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        fact           TEXT    NOT NULL,
        source_session TEXT    NOT NULL,
        created_at     INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
        embedding      BLOB
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS memory_facts_fts
        USING fts5(fact, content='memory_facts', content_rowid='id');

      -- Triggers to keep FTS index in sync with memory_facts
      CREATE TRIGGER IF NOT EXISTS memory_facts_ai AFTER INSERT ON memory_facts BEGIN
        INSERT INTO memory_facts_fts(rowid, fact) VALUES (new.id, new.fact);
      END;

      CREATE TRIGGER IF NOT EXISTS memory_facts_ad AFTER DELETE ON memory_facts BEGIN
        INSERT INTO memory_facts_fts(memory_facts_fts, rowid, fact) VALUES ('delete', old.id, old.fact);
      END;

      CREATE TRIGGER IF NOT EXISTS memory_facts_au AFTER UPDATE ON memory_facts BEGIN
        INSERT INTO memory_facts_fts(memory_facts_fts, rowid, fact) VALUES ('delete', old.id, old.fact);
        INSERT INTO memory_facts_fts(rowid, fact) VALUES (new.id, new.fact);
      END;

      CREATE TABLE IF NOT EXISTS inbox_state (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at TEXT DEFAULT (datetime('now'))
      );
    `);
  }

  // ── Sessions ───────────────────────────────────────────────────

  getOrCreateSession(sessionId: string): Session {
    const now = Date.now();

    const existing = this.db
      .prepare('SELECT * FROM sessions WHERE id = ?')
      .get(sessionId) as Session | undefined;

    if (existing) {
      this.db
        .prepare('UPDATE sessions SET updated_at = ? WHERE id = ?')
        .run(now, sessionId);
      return { ...existing, updated_at: now };
    }

    this.db
      .prepare('INSERT INTO sessions (id, created_at, updated_at) VALUES (?, ?, ?)')
      .run(sessionId, now, now);

    return { id: sessionId, created_at: now, updated_at: now };
  }

  // ── Messages ───────────────────────────────────────────────────

  getSessionMessages(sessionId: string, limit: number = 50): Message[] {
    return this.db
      .prepare(
        `SELECT * FROM (
           SELECT * FROM messages
           WHERE session_id = ?
           ORDER BY timestamp DESC
           LIMIT ?
         ) ORDER BY timestamp ASC`
      )
      .all(sessionId, limit) as Message[];
  }

  appendMessage(
    sessionId: string,
    role: Message['role'],
    content: string,
    toolName?: string
  ): Message {
    const now = Date.now();

    // Ensure session exists
    this.getOrCreateSession(sessionId);

    const result = this.db
      .prepare(
        `INSERT INTO messages (session_id, role, content, tool_name, timestamp)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(sessionId, role, content, toolName ?? null, now);

    return {
      id: Number(result.lastInsertRowid),
      session_id: sessionId,
      role,
      content,
      tool_name: toolName ?? null,
      timestamp: now,
    };
  }

  // ── Memory Facts ───────────────────────────────────────────────

  searchMemory(query: string, limit: number = 10): MemorySearchResult[] {
    // Escape the query as an FTS5 phrase to neutralize operators (AND, OR, NOT, *, ")
    const escaped = '"' + query.replace(/"/g, '""') + '"';
    return this.db
      .prepare(
        `SELECT m.id, m.fact, m.source_session, m.created_at, f.rank
         FROM memory_facts_fts f
         JOIN memory_facts m ON m.id = f.rowid
         WHERE memory_facts_fts MATCH ?
         ORDER BY f.rank
         LIMIT ?`
      )
      .all(escaped, limit) as MemorySearchResult[];
  }

  addFact(fact: string, sourceSession: string): MemoryFact {
    const now = Date.now();

    const result = this.db
      .prepare(
        `INSERT INTO memory_facts (fact, source_session, created_at)
         VALUES (?, ?, ?)`
      )
      .run(fact, sourceSession, now);

    return {
      id: Number(result.lastInsertRowid),
      fact,
      source_session: sourceSession,
      created_at: now,
      embedding: null,
    };
  }

  getRecentFacts(limit: number = 20): MemoryFact[] {
    return this.db
      .prepare(
        `SELECT * FROM memory_facts
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(limit) as MemoryFact[];
  }

  // ── Inbox State ────────────────────────────────────────────────

  getInboxState(key: string): string | null {
    const row = this.db
      .prepare('SELECT value FROM inbox_state WHERE key = ?')
      .get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setInboxState(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO inbox_state (key, value, updated_at)
         VALUES (?, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
      .run(key, value);
  }

  // ── Stats ──────────────────────────────────────────────────────

  getSessionCount(): number {
    const row = this.db
      .prepare('SELECT COUNT(*) as count FROM sessions')
      .get() as { count: number };
    return row.count;
  }

  getMessageCount(): number {
    const row = this.db
      .prepare('SELECT COUNT(*) as count FROM messages')
      .get() as { count: number };
    return row.count;
  }

  // ── Cleanup ────────────────────────────────────────────────────

  close(): void {
    this.db.close();
  }
}
