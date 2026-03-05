/**
 * Remote Control session manager for Claude Code.
 *
 * Spawns `claude remote-control` as a child process, captures the session URL,
 * and provides lifecycle management (start/stop/status).
 */

import { spawn, type ChildProcess } from 'node:child_process';

const URL_TIMEOUT_MS = 30_000; // max wait for URL to appear in stdout
const URL_PATTERN = /https:\/\/claude\.ai\/code\/[^\s]+/;

interface RemoteSession {
  process: ChildProcess;
  url: string;
  repoPath: string;
  startedAt: Date;
}

export class RemoteControlManager {
  private session: RemoteSession | null = null;
  private sendNotification: (msg: string) => Promise<void>;

  constructor(opts: { sendNotification: (msg: string) => Promise<void> }) {
    this.sendNotification = opts.sendNotification;
  }

  /**
   * Start a new remote control session in the given repo directory.
   * Returns the session URL or throws on failure.
   */
  async start(repoPath: string): Promise<string> {
    if (this.session) {
      throw new Error(
        `A remote session is already active: ${this.session.url}\nStop it first or use the existing URL.`,
      );
    }

    const child = spawn('claude', ['remote-control'], {
      cwd: repoPath,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CLAUDECODE: undefined },
    });

    // Wait for the URL to appear in stdout
    const url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error('Timed out waiting for remote control URL'));
      }, URL_TIMEOUT_MS);

      let buffer = '';

      const onData = (chunk: Buffer) => {
        buffer += chunk.toString();
        const match = buffer.match(URL_PATTERN);
        if (match) {
          clearTimeout(timer);
          child.stdout?.off('data', onData);
          child.stderr?.off('data', onStderr);
          resolve(match[0]);
        }
      };

      const onStderr = (chunk: Buffer) => {
        buffer += chunk.toString();
        const match = buffer.match(URL_PATTERN);
        if (match) {
          clearTimeout(timer);
          child.stdout?.off('data', onData);
          child.stderr?.off('data', onStderr);
          resolve(match[0]);
        }
      };

      child.stdout?.on('data', onData);
      child.stderr?.on('data', onStderr);

      child.on('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`Failed to start claude remote-control: ${err.message}`));
      });

      child.on('exit', (code) => {
        clearTimeout(timer);
        if (!buffer.match(URL_PATTERN)) {
          reject(new Error(`claude remote-control exited with code ${code} before producing a URL`));
        }
      });
    });

    this.session = { process: child, url, repoPath, startedAt: new Date() };

    // Watch for process exit (user closed from phone, network timeout, etc.)
    child.on('exit', (code) => {
      if (this.session?.process === child) {
        this.session = null;
        const reason = code === 0 ? 'Session ended normally' : `Process exited with code ${code}`;
        console.log(`[remote-control] ${reason}`);
        void this.sendNotification(`Remote Control session ended. ${reason}`).catch(() => {});
      }
    });

    console.log(`[remote-control] Session started: ${url} (cwd: ${repoPath})`);
    return url;
  }

  /**
   * Stop the active remote control session.
   */
  stop(): void {
    if (!this.session) return;
    const { process: child, url } = this.session;
    this.session = null;
    child.kill('SIGTERM');
    console.log(`[remote-control] Session stopped: ${url}`);
  }

  isActive(): boolean {
    return this.session !== null;
  }

  getInfo(): { url: string; repoPath: string; startedAt: Date } | null {
    if (!this.session) return null;
    return {
      url: this.session.url,
      repoPath: this.session.repoPath,
      startedAt: this.session.startedAt,
    };
  }
}
