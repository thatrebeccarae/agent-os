/**
 * Heartbeat state collector — gathers a lightweight snapshot of Agent's current state.
 * This is the ONLY context the heartbeat LLM call receives — keep it small.
 */

import type { AgentStore } from '../memory/store.js';
import type { TaskQueue } from '../tasks/queue.js';
import type { ClaudeCodeExecutor } from '../claude-code/executor.js';
import type { InboxMonitor } from '../inbox/monitor.js';
import type { DockerMonitor } from '../inbox/docker-monitor.js';
import type { CalendarMonitor } from '../inbox/calendar-monitor.js';

export interface HeartbeatState {
  timestamp: string;
  uptime: string;
  pendingTasks: number;
  runningTasks: number;
  failedTasksRecent: number;
  lastUserMessage: { sessionId: string; ago: string } | null;
  activeClaudeCode: { title: string; durationMin: number } | null;
  monitors: {
    inbox: { lastCheck: string | null; status: string };
    docker: { lastCheck: string | null; status: string };
    calendar: { lastCheck: string | null; status: string };
  };
  recentFacts: string[];
}

export interface HeartbeatDeps {
  store: AgentStore;
  taskQueue: TaskQueue;
  claudeCodeExecutor: ClaudeCodeExecutor | null;
  inboxMonitor: InboxMonitor | null;
  dockerMonitor: DockerMonitor | null;
  calendarMonitor: CalendarMonitor | null;
  startTime: number;
}

let _deps: HeartbeatDeps | null = null;

export function setHeartbeatDeps(deps: HeartbeatDeps): void {
  _deps = deps;
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export function collectState(): HeartbeatState {
  if (!_deps) throw new Error('HeartbeatDeps not initialized — call setHeartbeatDeps() first');

  const { store, taskQueue, claudeCodeExecutor, inboxMonitor, dockerMonitor, calendarMonitor, startTime } = _deps;
  const now = Date.now();

  // Task counts
  const pendingTasks = taskQueue.getPendingCount();
  const runningTasks = taskQueue.listTasks('running', 100).length;

  // Failed tasks in last hour
  const recentFailed = taskQueue.listTasks('failed', 50);
  const oneHourAgo = new Date(now - 60 * 60 * 1000).toISOString();
  const failedTasksRecent = recentFailed.filter((t) => t.completedAt && t.completedAt > oneHourAgo).length;

  // Last user message
  let lastUserMessage: HeartbeatState['lastUserMessage'] = null;
  try {
    const row = store.db
      .prepare(
        `SELECT m.session_id, m.timestamp
         FROM messages m
         WHERE m.role = 'user'
         ORDER BY m.timestamp DESC
         LIMIT 1`,
      )
      .get() as { session_id: string; timestamp: number } | undefined;

    if (row) {
      const agoMs = now - row.timestamp;
      lastUserMessage = { sessionId: row.session_id, ago: formatDuration(agoMs) };
    }
  } catch {
    // DB query failed — leave as null
  }

  // Active Claude Code session
  let activeClaudeCode: HeartbeatState['activeClaudeCode'] = null;
  if (claudeCodeExecutor?.isActive()) {
    const info = claudeCodeExecutor.getActiveInfo();
    if (info) {
      activeClaudeCode = {
        title: info.title,
        durationMin: Math.round((now - info.startedAt.getTime()) / 60_000),
      };
    }
  }

  // Monitor status
  const monitorStatus = (monitor: { getLastCheckTime(): Date | null } | null, label: string) => {
    if (!monitor) return { lastCheck: null, status: 'disabled' };
    const lastCheck = monitor.getLastCheckTime();
    return {
      lastCheck: lastCheck?.toISOString() ?? null,
      status: 'active',
    };
  };

  // Recent facts (just the text, not full objects)
  const facts = store.getRecentFacts(5);
  const recentFacts = facts.map((f) => f.fact);

  return {
    timestamp: new Date(now).toISOString(),
    uptime: formatDuration(now - startTime),
    pendingTasks,
    runningTasks,
    failedTasksRecent,
    lastUserMessage,
    activeClaudeCode,
    monitors: {
      inbox: monitorStatus(inboxMonitor as { getLastCheckTime(): Date | null } | null, 'inbox'),
      docker: monitorStatus(dockerMonitor as { getLastCheckTime(): Date | null } | null, 'docker'),
      calendar: monitorStatus(calendarMonitor as { getLastCheckTime(): Date | null } | null, 'calendar'),
    },
    recentFacts,
  };
}
