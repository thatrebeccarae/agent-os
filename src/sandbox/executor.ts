/**
 * Sandbox executor — main entry point for safe command execution.
 *
 * Auto-selects between:
 *   Tier 1 (lightweight): direct child_process with allow-list + path restriction
 *   Tier 2 (docker):      full container sandbox with resource/security limits
 *
 * Falls back to lightweight-only if Docker is not available.
 */

import path from 'node:path';
import { executeLightweight, isAllowed } from './lightweight.js';
import { executeDocker, isDockerAvailable, type DockerOptions } from './docker.js';

export interface ExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  truncated: boolean;
}

export interface ExecutionOptions {
  /** Override timeout in ms */
  timeoutMs?: number;
  /** Override max output in bytes */
  maxOutputBytes?: number;
  /** Force a specific tier instead of auto-selecting */
  tier?: 'lightweight' | 'docker';
}

const WORKSPACE_DIR = path.resolve(process.cwd(), 'data', 'workspace');

/** Cached Docker availability check. */
let dockerAvailable: boolean | null = null;

/** Check Docker availability and cache the result. */
export async function checkDockerAvailability(): Promise<boolean> {
  if (dockerAvailable === null) {
    dockerAvailable = await isDockerAvailable();
  }
  return dockerAvailable;
}

/**
 * Heuristic: should this command run in Docker?
 * Returns true for commands that aren't in the lightweight allow-list,
 * or that use shell features suggesting untrusted complexity.
 */
function needsDocker(command: string): boolean {
  // If the base command isn't in the allow-list, use Docker
  if (!isAllowed(command)) {
    return true;
  }

  // Dangerous shell patterns that warrant Docker isolation
  const dangerousPatterns = [
    /\bsudo\b/,
    /\bchmod\b.*\+s/,           // setuid
    /\bdd\b.*of=\/dev\//,       // raw device writes
    />\s*\/etc\//,              // writing to /etc
    />\s*\/usr\//,              // writing to /usr
    /\bkill\b/,
    /\bkillall\b/,
    /\bmkfs\b/,
    /\bfdisk\b/,
    /\biptables\b/,
  ];

  return dangerousPatterns.some((p) => p.test(command));
}

/**
 * Execute a command in the appropriate sandbox tier.
 *
 * Decision logic:
 * 1. If tier is forced via options, use that tier.
 * 2. If the command is in the allow-list and not dangerous, use lightweight.
 * 3. If Docker is available, use Docker.
 * 4. If Docker is unavailable and command isn't allowed, reject it.
 */
export async function executeCommand(
  command: string,
  options: ExecutionOptions & DockerOptions = {},
): Promise<ExecutionResult> {
  const workspaceDir = WORKSPACE_DIR;

  // Forced tier
  if (options.tier === 'lightweight') {
    return executeLightweight(command, workspaceDir, options);
  }

  if (options.tier === 'docker') {
    const hasDocker = await checkDockerAvailability();
    if (!hasDocker) {
      return {
        stdout: '',
        stderr: 'Docker is not available on this system. Cannot execute in Docker tier.',
        exitCode: 127,
        timedOut: false,
        truncated: false,
      };
    }
    return executeDocker(command, workspaceDir, options);
  }

  // Auto-select tier
  if (!needsDocker(command)) {
    return executeLightweight(command, workspaceDir, options);
  }

  // Command needs Docker — check availability
  const hasDocker = await checkDockerAvailability();
  if (hasDocker) {
    return executeDocker(command, workspaceDir, options);
  }

  // Docker not available and command isn't in the allow-list
  return {
    stdout: '',
    stderr: `Command requires Docker sandbox but Docker is not available. Command not in lightweight allow-list.`,
    exitCode: 127,
    timedOut: false,
    truncated: false,
  };
}
