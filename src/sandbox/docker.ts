/**
 * Tier 2 — Full Docker sandbox for untrusted/complex execution.
 * Spawns a container with strict resource/security limits.
 */

import { execFile } from 'node:child_process';
import path from 'node:path';
import type { ExecutionResult, ExecutionOptions } from './executor.js';
import { truncate } from './utils.js';

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 10 * 1024; // 10 KB
const DEFAULT_IMAGE = 'node:22-slim';
const DEFAULT_MEMORY = '512m';
const DEFAULT_CPUS = '0.5';

export interface DockerOptions extends ExecutionOptions {
  /** Allow network access (default: false — runs with --network none) */
  networkAccess?: boolean;
}

/** Check if Docker is available on this system. */
export async function isDockerAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('docker', ['info'], { timeout: 5_000 }, (error) => {
      resolve(error === null);
    });
  });
}

/** Execute a command inside a Docker container with strict sandboxing. */
export async function executeDocker(
  command: string,
  workspaceDir: string,
  options: DockerOptions = {},
): Promise<ExecutionResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutput = options.maxOutputBytes ?? MAX_OUTPUT_BYTES;

  const absWorkspace = path.resolve(workspaceDir);

  const dockerArgs: string[] = [
    'run',
    '--rm',                                         // auto-delete container
    '--memory', DEFAULT_MEMORY,                      // memory limit
    '--cpus', DEFAULT_CPUS,                         // CPU limit
    '--read-only',                                  // read-only root filesystem
    '--tmpfs', '/tmp:size=100m',                    // writable /tmp
    '--cap-drop', 'ALL',                            // drop all capabilities
    '--security-opt', 'no-new-privileges',          // prevent privilege escalation
    '--workdir', '/workspace',                      // set working dir
    '-v', `${absWorkspace}:/workspace`,             // bind mount workspace
  ];

  // Network isolation (default: no network)
  if (!options.networkAccess) {
    dockerArgs.push('--network', 'none');
  }

  // Image and command
  dockerArgs.push(DEFAULT_IMAGE, '/bin/sh', '-c', command);

  return new Promise((resolve) => {
    const child = execFile(
      'docker',
      dockerArgs,
      {
        timeout: timeoutMs,
        maxBuffer: maxOutput * 2,
      },
      (error, stdout, stderr) => {
        const timedOut = error !== null && 'killed' in error && error.killed === true;

        const outResult = truncate(stdout, maxOutput);
        const errResult = truncate(stderr, maxOutput);

        let exitCode = 0;
        if (child.exitCode !== null) {
          exitCode = child.exitCode;
        } else if (error) {
          exitCode = 1;
        }

        resolve({
          stdout: outResult.text,
          stderr: errResult.text,
          exitCode,
          timedOut,
          truncated: outResult.truncated || errResult.truncated,
        });
      },
    );
  });
}
