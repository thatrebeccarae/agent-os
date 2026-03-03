/**
 * agent-browser wrapper — shells out to the `agent-browser` CLI
 * for LLM-optimized browser interaction via snapshot+refs workflow.
 *
 * Uses a persistent daemon session (named "tars") so refs and state
 * survive between tool calls within a conversation.
 */

import { execFile } from 'node:child_process';
import { validateUrl } from './security.js';
import { AGENT_NAME } from '../config/identity.js';

const SESSION_NAME = AGENT_NAME.toLowerCase();
const COMMAND_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_CHARS = 10_000;

/** Commands that navigate to a URL and require SSRF validation. */
const URL_COMMANDS = new Set(['open', 'goto', 'navigate']);

/** Parse the URL from a command's arguments (first arg after command name). */
function extractUrlFromArgs(args: string[]): string | null {
  for (const arg of args) {
    if (arg.startsWith('-')) continue;
    // Treat ANY non-flag argument as a potential URL for SSRF validation
    return arg.startsWith('http') || arg.includes('://') ? arg : `https://${arg}`;
  }
  return null;
}

/**
 * Check if agent-browser CLI is available.
 */
export async function isAgentBrowserAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('agent-browser', ['--version'], { timeout: 5_000 }, (error) => {
      resolve(error === null);
    });
  });
}

/** Cached availability check result. */
let _available: boolean | null = null;

export async function checkAvailability(): Promise<boolean> {
  if (_available === null) {
    _available = await isAgentBrowserAvailable();
  }
  return _available;
}

/**
 * Execute an agent-browser command. Returns stdout on success, error string on failure.
 *
 * Applies SSRF validation before any navigation command.
 */
export async function executeAgentBrowser(
  command: string,
  args: string[],
): Promise<{ success: boolean; output: string }> {
  // SSRF check: validate URLs before navigation commands
  if (URL_COMMANDS.has(command)) {
    const url = extractUrlFromArgs(args);
    if (!url) {
      return { success: false, output: 'Error: navigation command requires a URL argument' };
    }
    const check = await validateUrl(url);
    if (!check.valid) {
      return { success: false, output: `Error: ${check.reason}` };
    }
  }

  const fullArgs = ['--session', SESSION_NAME, command, ...args];

  return new Promise((resolve) => {
    execFile(
      'agent-browser',
      fullArgs,
      {
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_CHARS * 2,
        env: {
          ...process.env,
          // Ensure no interactive prompts
          CI: '1',
        },
      },
      (error, stdout, stderr) => {
        if (error) {
          const timedOut = 'killed' in error && error.killed === true;
          if (timedOut) {
            resolve({ success: false, output: 'Error: command timed out (30s)' });
            return;
          }
          // agent-browser returns non-zero on errors but still writes to stdout
          const output = stdout.trim() || stderr.trim() || error.message;
          resolve({ success: false, output: truncateOutput(output) });
          return;
        }

        resolve({ success: true, output: truncateOutput(stdout.trim()) });
      },
    );
  });
}

/**
 * Close the agent-browser session. Call on shutdown.
 */
export async function closeSession(): Promise<void> {
  return new Promise((resolve) => {
    execFile(
      'agent-browser',
      ['--session', SESSION_NAME, 'close'],
      { timeout: 10_000 },
      () => {
        // Ignore errors — session may not be running
        resolve();
      },
    );
  });
}

function truncateOutput(output: string): string {
  if (output.length > MAX_OUTPUT_CHARS) {
    return output.slice(0, MAX_OUTPUT_CHARS) + '\n\n[truncated]';
  }
  return output;
}
