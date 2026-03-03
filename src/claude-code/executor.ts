import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKMessage, SDKResultError, PermissionResult, Query as SDKQuery } from '@anthropic-ai/claude-agent-sdk';
import type { ApprovalManager } from './approvals.js';
import path from 'node:path';
import { isHeightenedSecurity } from '../security/content-boundary.js';
import { CLAUDE_CODE_ALLOWED_PATHS, OPERATOR_NAME } from '../config/identity.js';

export interface DispatchOptions {
  title: string;
  description: string;
  repoPath: string;
}

interface ActiveSession {
  taskTitle: string;
  startedAt: Date;
  sessionId?: string;
  messageCount: number;
  query?: SDKQuery;
}

/** Paths the Claude Code agent is allowed to work in. */
const ALLOWED_PATH_PREFIXES = CLAUDE_CODE_ALLOWED_PATHS;

/**
 * Bash patterns that are auto-denied — never reach the human.
 * Not a security boundary, just a fast-reject for obviously dangerous commands.
 */
const BLOCKED_BASH_PATTERNS = [
  /rm\s+(-\w*r\w*\s+-\w*f|-\w*f\w*\s+-\w*r|-rf|-fr)\s+[/~]/, // rm -rf variants
  /git\s+push\s+(-f|--force)\s*(origin\s+)?(main|master)/,      // force push to main
  /git\s+push\s+(origin\s+)?(main|master)\s+(-f|--force)/,      // force push (flag after branch)
  /(^|[\s;|&])\/?(usr\/bin\/)?(curl|wget)\s/,                   // curl/wget (any path)
  /bash\s+-c\s+.*\b(curl|wget)\b/,                              // curl/wget nested in bash -c
  /\bsocat\s/,                                                     // network relay tool
  /\btelnet\s/,                                                    // raw network connections
  /\bnmap\s/,                                                      // network scanning
];

/**
 * Bash commands that start with these tokens are auto-approved (read-only / safe).
 * Everything else routes through the Telegram approval flow.
 */
const SAFE_BASH_PREFIXES = [
  'ls', 'cat', 'head', 'tail', 'wc', 'find', 'which', 'echo', 'printf',
  'date', 'pwd', 'whoami', 'uname', 'df', 'du', 'file', 'stat', 'diff',
  'sort', 'uniq', 'tr', 'cut', 'grep', 'rg', 'ag',
  'git log', 'git status', 'git diff', 'git branch', 'git show', 'git rev-parse',
  'git remote', 'git tag', 'git stash list',
  'node --version', 'npm --version', 'npx tsc --noEmit', 'pnpm --version',
  'jq',
];

const MAX_TURNS = 50;

export class ClaudeCodeExecutor {
  private approvalManager: ApprovalManager;
  private sendStatus: (msg: string) => Promise<void>;
  private sendResult: (msg: string) => Promise<void>;
  private activeSession: ActiveSession | null = null;
  private ownerSessionId: string | null = null;

  constructor(opts: {
    approvalManager: ApprovalManager;
    sendStatus: (msg: string) => Promise<void>;
    sendResult: (msg: string) => Promise<void>;
  }) {
    this.approvalManager = opts.approvalManager;
    this.sendStatus = opts.sendStatus;
    this.sendResult = opts.sendResult;
  }

  setOwnerSessionId(sessionId: string): void {
    this.ownerSessionId = sessionId;
  }

  /** Whether a Claude Code task is currently running. */
  isActive(): boolean {
    return this.activeSession !== null;
  }

  /** Get info about the active session, if any. */
  getActiveInfo(): { title: string; startedAt: Date } | null {
    if (!this.activeSession) return null;
    return { title: this.activeSession.taskTitle, startedAt: this.activeSession.startedAt };
  }

  /**
   * Abort the active session. Cancels pending approvals and closes the SDK query.
   * Safe to call even if no session is active.
   */
  abort(): void {
    this.approvalManager.cancelAll();
    if (this.activeSession?.query) {
      this.activeSession.query.close();
    }
  }

  /**
   * Fire-and-forget dispatch. Starts a Claude Code session in the background.
   * Throws if a session is already active.
   */
  dispatch(opts: DispatchOptions): void {
    if (this.activeSession) {
      throw new Error(
        `A Claude Code task is already running: "${this.activeSession.taskTitle}" ` +
        `(started ${this.activeSession.startedAt.toISOString()})`,
      );
    }

    // Validate repo path
    const resolved = path.resolve(opts.repoPath);
    const isAllowed = ALLOWED_PATH_PREFIXES.some((prefix) => resolved.startsWith(prefix));
    if (!isAllowed) {
      throw new Error(
        `Repo path not allowed: ${opts.repoPath}. ` +
        `Must be under: ${ALLOWED_PATH_PREFIXES.join(', ')}`,
      );
    }

    this.activeSession = {
      taskTitle: opts.title,
      startedAt: new Date(),
      messageCount: 0,
    };

    void this.sendStatus(`Starting Claude Code session for: ${opts.title}`);

    // Fire-and-forget — errors are caught and reported
    void this.runSession(opts).catch(async (err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[claude-code] Session error:', msg);
      await this.sendResult(`Claude Code session failed: ${msg}`).catch(() => {});
      this.activeSession = null;
    });
  }

  private async runSession(opts: DispatchOptions): Promise<void> {
    const prompt = [
      `# Task: ${opts.title}`,
      '',
      opts.description,
      '',
      '---',
      'Work autonomously. Read the codebase first, then make changes.',
      'When done, provide a BRIEF summary (3-5 sentences max) of what you did, key findings, and any issues.',
      'Do NOT include full file listings, tables, or verbose output — just the essentials.',
    ].join('\n');

    const q = query({
      prompt,
      options: {
        cwd: path.resolve(opts.repoPath),
        permissionMode: 'default',
        // Bash excluded from allowedTools so it routes through canUseTool:
        // blocked patterns → auto-deny, safe prefixes → auto-approve, else → Telegram approval
        allowedTools: ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Task', 'EnterPlanMode', 'ExitPlanMode'],
        model: 'claude-sonnet-4-6',
        maxTurns: MAX_TURNS,
        persistSession: false,
        canUseTool: async (toolName, input, options) => {
          // Respect SDK abort signal — deny immediately if aborted
          if (options.signal.aborted) {
            return { behavior: 'deny', message: 'Session aborted' };
          }
          return this.handlePermission(toolName, input, options.signal);
        },
      },
    });

    // Store query reference so abort() can close it
    this.activeSession!.query = q;

    try {
      for await (const message of q) {
        // Capture session ref — safe because we're in the sync for-await loop
        const session = this.activeSession;
        if (!session) break; // Session was cleared externally (abort)

        try {
          await this.handleMessage(message, session);
        } catch (err) {
          console.error('[claude-code] Error handling message:', err);
        }
      }
    } finally {
      this.activeSession = null;
    }
  }

  private async handleMessage(message: SDKMessage, session: ActiveSession): Promise<void> {
    if (message.type === 'system' && message.subtype === 'init') {
      session.sessionId = message.session_id;
      console.log(`[claude-code] Session initialized: ${message.session_id}, model: ${message.model}`);
      return;
    }

    if (message.type === 'assistant') {
      session.messageCount++;
      return;
    }

    if (message.type === 'result') {
      if (message.subtype === 'success') {
        const cost = message.total_cost_usd.toFixed(4);
        const turns = message.num_turns;
        const resultText = message.result.length > 500
          ? message.result.slice(0, 500) + '\n\n[truncated]'
          : message.result;

        await this.sendResult(
          `Claude Code completed: ${session.taskTitle}\n\n` +
          `${resultText}\n\n` +
          `${turns} turns, $${cost}`,
        );
      } else {
        const errResult = message as SDKResultError;
        const errorMsg = errResult.errors.length > 0
          ? errResult.errors.join('\n')
          : `Failed with: ${errResult.subtype}`;
        await this.sendResult(
          `Claude Code failed: ${session.taskTitle}\n\n${errorMsg}`,
        );
      }
    }
  }

  private async handlePermission(
    toolName: string,
    input: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<PermissionResult> {
    if (toolName === 'Bash') {
      const command = ((input.command as string) ?? '').trim();

      // Layer 1: Auto-deny dangerous commands (never reach human)
      for (const pattern of BLOCKED_BASH_PATTERNS) {
        if (pattern.test(command)) {
          return { behavior: 'deny', message: `Blocked dangerous command: ${command}` };
        }
      }

      // Layer 1.5: Heightened security — skip auto-approve, route ALL Bash to Telegram
      if (this.ownerSessionId && isHeightenedSecurity(this.ownerSessionId)) {
        const description = `[HEIGHTENED SECURITY] ${formatToolDescription(toolName, input)}`;
        const result = await this.approvalManager.requestApproval(description, signal);
        if (result.approved) {
          return { behavior: 'allow' };
        }
        return { behavior: 'deny', message: `Denied by ${OPERATOR_NAME} via Telegram (heightened security)` };
      }

      // Layer 2: Auto-approve safe read-only commands
      // Require word boundary after prefix so 'cat' doesn't match 'catalog'
      const isSafe = SAFE_BASH_PREFIXES.some((prefix) => {
        if (!command.startsWith(prefix)) return false;
        const next = command[prefix.length];
        return next === undefined || next === ' ' || next === '|';
      });
      if (isSafe) {
        return { behavior: 'allow' };
      }
    }

    // Layer 3: Everything else routes to Telegram approval
    const description = formatToolDescription(toolName, input);
    const result = await this.approvalManager.requestApproval(description, signal);
    if (result.approved) {
      return { behavior: 'allow' };
    }
    return { behavior: 'deny', message: `Denied by ${OPERATOR_NAME} via Telegram` };
  }
}

function formatToolDescription(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case 'Bash': {
      const cmd = (input.command as string) ?? '(unknown)';
      return `Tool: Bash\nCommand: ${cmd}`;
    }
    case 'Write': {
      const filePath = (input.file_path as string) ?? '(unknown)';
      return `Tool: Write\nFile: ${filePath}`;
    }
    case 'Edit': {
      const filePath = (input.file_path as string) ?? '(unknown)';
      return `Tool: Edit\nFile: ${filePath}`;
    }
    default: {
      const summary = JSON.stringify(input).slice(0, 200);
      return `Tool: ${toolName}\nInput: ${summary}`;
    }
  }
}
