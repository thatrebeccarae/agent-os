import 'dotenv/config';
import { installLogCapture } from './dashboard/log-buffer.js';

// Install log capture BEFORE any other imports log to console
installLogCapture();

import { AgentStore } from './memory/store.js';
import { TelegramChannel } from './channels/telegram.js';
import { Gateway } from './gateway/router.js';
import { LLMRouter } from './llm/router.js';
import { startHealthServer, setTaskQueue as setServerTaskQueue } from './gateway/server.js';
import { TaskQueue } from './tasks/queue.js';
import { TaskWorker } from './tasks/worker.js';
import { Scheduler } from './tasks/scheduler.js';
import { setTaskQueue as setToolsTaskQueue, setClaudeCodeExecutor, setRemoteControlManager } from './agent/tools.js';
import { loadSkills } from './skills/loader.js';
import { isSkillsEnabled } from './skills/config.js';
import { isProactiveEnabled, isInboxMonitorEnabled, isCalendarMonitorEnabled, getOwnerSessionId } from './inbox/config.js';
import { InboxMonitor } from './inbox/monitor.js';
import { DockerMonitor } from './inbox/docker-monitor.js';
import { CalendarMonitor } from './inbox/calendar-monitor.js';
import { ApprovalManager } from './claude-code/approvals.js';
import { ClaudeCodeExecutor } from './claude-code/executor.js';
import { RemoteControlManager } from './claude-code/remote.js';
import { closeBrowser } from './browser/manager.js';
import { setDashboardState } from './dashboard/api.js';
import { startIntegrityChecker, stopIntegrityChecker } from './dashboard/integrity.js';
import { HeartbeatMonitor, isHeartbeatEnabled } from './heartbeat/monitor.js';
import { setHeartbeatDeps } from './heartbeat/state.js';
import { isMinifluxConfigured } from './miniflux/client.js';
import { scheduleMorningDigest } from './miniflux/digest.js';
import { setInjectionCallback, setHeightenedSecurity } from './security/content-boundary.js';
import { PACKAGE_NAME } from './config/identity.js';
import { setExtractStore } from './memory/extract.js';

// ---------------------------------------------------------------------------
// Validate env — at least one LLM backend must be available
// ---------------------------------------------------------------------------

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

if (!TELEGRAM_BOT_TOKEN) {
  console.error('Missing TELEGRAM_BOT_TOKEN');
  process.exit(1);
}

if (!process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY && !process.env.GEMINI_API_KEY) {
  console.warn(`[${PACKAGE_NAME}] No cloud API keys set — will use Ollama only (if available)`);
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

const store = new AgentStore();
setExtractStore(store);
const router = new LLMRouter();
const allowedUsers = process.env.TELEGRAM_ALLOWED_USERS?.split(',').map((s) => s.trim()).filter(Boolean);
const telegram = new TelegramChannel(TELEGRAM_BOT_TOKEN, allowedUsers);
const gateway = new Gateway(store, router);

gateway.registerChannel(telegram);

// ---------------------------------------------------------------------------
// Slack (optional)
// ---------------------------------------------------------------------------

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
if (SLACK_BOT_TOKEN) {
  const { SlackChannel } = await import('./channels/slack.js');
  const slack = new SlackChannel({
    botToken: SLACK_BOT_TOKEN,
    appToken: process.env.SLACK_APP_TOKEN,
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    channelId: process.env.SLACK_CHANNEL_ID,
  });
  gateway.registerChannel(slack);
  console.log(`[${PACKAGE_NAME}] Slack channel enabled`);
} else {
  console.log(`[${PACKAGE_NAME}] Slack channel not configured (no SLACK_BOT_TOKEN)`);
}

// ---------------------------------------------------------------------------
// Task queue + worker + scheduler
// ---------------------------------------------------------------------------

const taskQueue = new TaskQueue(store.db);
setToolsTaskQueue(taskQueue);
setServerTaskQueue(taskQueue);

const taskWorker = new TaskWorker({
  router,
  store,
  queue: taskQueue,
  notifyCallback: async (sessionId, message) => {
    if (sessionId) {
      await gateway.sendToSession(sessionId, message);
    }
  },
});

const scheduler = new Scheduler(taskQueue);

// Direct cleanup of old tasks every 24 hours (no LLM call needed)
setInterval(() => taskQueue.cleanupOldTasks(30), 24 * 60 * 60 * 1000);

const healthServer = startHealthServer(store);

// ---------------------------------------------------------------------------
// Skills framework (Phase 12)
// ---------------------------------------------------------------------------

if (isSkillsEnabled()) {
  const loaded = await loadSkills();
  console.log(`[skills] Loaded ${loaded.length} skill(s)`);
} else {
  console.log('[skills] Skills framework disabled (SKILLS_ENABLED=false)');
}

await gateway.start();

taskWorker.start();
scheduler.start();

// ---------------------------------------------------------------------------
// Proactive monitors (Phase 6)
// ---------------------------------------------------------------------------

let inboxMonitor: InboxMonitor | null = null;
let dockerMonitor: DockerMonitor | null = null;
let calendarMonitor: CalendarMonitor | null = null;

if (isProactiveEnabled()) {
  const ownerSessionId = getOwnerSessionId()!;
  const sendAlert = async (message: string) => {
    await gateway.sendToSession(ownerSessionId, message);
  };

  // Docker health monitor — needs only owner chat ID
  dockerMonitor = new DockerMonitor(sendAlert);
  dockerMonitor.start();

  // Inbox monitor — needs Gmail configured too
  if (isInboxMonitorEnabled()) {
    inboxMonitor = new InboxMonitor({ store, taskQueue, sendAlert });
    inboxMonitor.start();
  } else {
    console.log('[inbox] Monitor not started (Gmail not configured)');
  }

  // Calendar monitor — needs Google Calendar configured
  if (isCalendarMonitorEnabled()) {
    calendarMonitor = new CalendarMonitor(sendAlert);
    calendarMonitor.start();
  } else {
    console.log('[calendar] Monitor not started (Calendar not configured)');
  }
} else {
  console.log(`[${PACKAGE_NAME}] Proactive monitoring disabled (no TELEGRAM_OWNER_CHAT_ID)`);
}

// ---------------------------------------------------------------------------
// Claude Code handoff (Phase 7)
// ---------------------------------------------------------------------------

let claudeCodeExecutor: ClaudeCodeExecutor | null = null;
let remoteControlManager: RemoteControlManager | null = null;

if (isProactiveEnabled() && process.env.ANTHROPIC_API_KEY) {
  const ownerChatId = process.env.TELEGRAM_OWNER_CHAT_ID!;
  const ownerSessionId = getOwnerSessionId()!;
  const bot = telegram.getBot();

  const approvalManager = new ApprovalManager(bot, ownerChatId);

  // Wire up callback query handler for inline keyboard approvals
  telegram.onCallbackQuery(async (data, answerCallback) => {
    const handled = approvalManager.handleCallback(data);
    await answerCallback();
    if (!handled) {
      console.warn('[claude-code] Unrecognized callback query:', data);
    }
  });

  claudeCodeExecutor = new ClaudeCodeExecutor({
    approvalManager,
    sendStatus: async (msg) => {
      await gateway.sendToSession(ownerSessionId, msg);
    },
    sendResult: async (msg) => {
      await gateway.sendToSession(ownerSessionId, msg);
    },
  });

  claudeCodeExecutor.setOwnerSessionId(ownerSessionId);

  // Wire injection response system
  setInjectionCallback((source, patterns) => {
    const msg = `⚠️ INJECTION DETECTED\nSource: ${source}\nPatterns: ${patterns.join(', ')}\n\nHeightened security activated for 30 minutes. All Claude Code Bash commands will require manual approval.`;
    void gateway.sendToSession(ownerSessionId, msg);
    setHeightenedSecurity(ownerSessionId);
  });

  setClaudeCodeExecutor(claudeCodeExecutor);
  console.log('[claude-code] Executor ready — handoff_to_claude_code tool enabled');

  // Remote Control manager — spawns `claude remote-control` on demand
  remoteControlManager = new RemoteControlManager({
    sendNotification: async (msg) => {
      await gateway.sendToSession(ownerSessionId, msg);
    },
  });
  setRemoteControlManager(remoteControlManager);
  console.log('[remote-control] Manager ready — start_remote_session tool enabled');
} else {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('[claude-code] Executor disabled (no ANTHROPIC_API_KEY)');
  } else {
    console.log('[claude-code] Executor disabled (no TELEGRAM_OWNER_CHAT_ID)');
  }
}

// ---------------------------------------------------------------------------
// Proactive heartbeat (Phase 11)
// ---------------------------------------------------------------------------

let heartbeatMonitor: HeartbeatMonitor | null = null;
const startTime = Date.now();

if (isProactiveEnabled() && isHeartbeatEnabled()) {
  const ownerSessionId = getOwnerSessionId()!;

  setHeartbeatDeps({
    store,
    taskQueue,
    claudeCodeExecutor,
    inboxMonitor,
    dockerMonitor,
    calendarMonitor,
    startTime,
  });

  heartbeatMonitor = new HeartbeatMonitor({
    router,
    sendAlert: async (msg) => gateway.sendToSession(ownerSessionId, msg),
    taskQueue,
  });
  heartbeatMonitor.start();
} else {
  if (!isHeartbeatEnabled()) {
    console.log('[heartbeat] Disabled via HEARTBEAT_ENABLED=false');
  }
}

// ---------------------------------------------------------------------------
// Morning RSS digest (Phase 17)
// ---------------------------------------------------------------------------

let cancelDigest: (() => void) | null = null;

if (isMinifluxConfigured() && isProactiveEnabled()) {
  const ownerSessionId = getOwnerSessionId()!;
  cancelDigest = scheduleMorningDigest({
    router,
    sendDigest: async (msg) => gateway.sendToSession(ownerSessionId, msg),
    markRead: false,
  });
  console.log(`[${PACKAGE_NAME}] Morning RSS digest scheduled`);
} else {
  if (!isMinifluxConfigured()) {
    console.log('[digest] Miniflux not configured (no MINIFLUX_API_KEY)');
  } else {
    console.log('[digest] Morning digest disabled (no TELEGRAM_OWNER_CHAT_ID)');
  }
}

// ---------------------------------------------------------------------------
// Dashboard state injection (Phase 8)
// ---------------------------------------------------------------------------

setDashboardState({
  store,
  taskQueue,
  router,
  claudeCodeExecutor,
  inboxMonitor,
  dockerMonitor,
  calendarMonitor,
  heartbeatMonitor,
  startTime,
});

// ---------------------------------------------------------------------------
// Config integrity checker (Phase 8)
// ---------------------------------------------------------------------------

if (isProactiveEnabled()) {
  const ownerSessionId = getOwnerSessionId()!;
  const integrityAlert = async (message: string) => {
    await gateway.sendToSession(ownerSessionId, message);
  };
  const projectRoot = new URL('..', import.meta.url).pathname;
  startIntegrityChecker(projectRoot, integrityAlert);
  console.log('[integrity] Config integrity checker started');
}

const pending = taskQueue.getPendingCount();
console.log(`[${PACKAGE_NAME}] Running | sessions: ${store.getSessionCount()} | messages: ${store.getMessageCount()} | pending tasks: ${pending}`);

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

async function shutdown(): Promise<void> {
  console.log(`\n[${PACKAGE_NAME}] Shutting down...`);
  cancelDigest?.();
  await closeBrowser();
  stopIntegrityChecker();
  if (remoteControlManager?.isActive()) {
    console.log('[remote-control] Stopping active remote session');
    remoteControlManager.stop();
  }
  if (claudeCodeExecutor?.isActive()) {
    const info = claudeCodeExecutor.getActiveInfo();
    console.warn(`[claude-code] Aborting active session: "${info?.title}"`);
    claudeCodeExecutor.abort();
  }
  heartbeatMonitor?.stop();
  inboxMonitor?.stop();
  dockerMonitor?.stop();
  calendarMonitor?.stop();
  scheduler.stop();
  taskWorker.stop();
  healthServer.close();
  await gateway.stop();
  store.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
