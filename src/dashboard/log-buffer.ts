/**
 * In-memory ring buffer for capturing console output.
 * Used by the dashboard /api/logs endpoint.
 */

const MAX_LINES = 500;

interface LogEntry {
  timestamp: number;
  level: 'log' | 'error' | 'warn';
  message: string;
}

const buffer: LogEntry[] = [];

export function getRecentLogs(limit: number = 100): LogEntry[] {
  return buffer.slice(-limit);
}

/**
 * Monkey-patch console.log, console.error, console.warn to capture output
 * into the ring buffer. Call once at startup.
 */
export function installLogCapture(): void {
  const origLog = console.log.bind(console);
  const origError = console.error.bind(console);
  const origWarn = console.warn.bind(console);

  function push(level: LogEntry['level'], args: unknown[]): void {
    const message = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    buffer.push({ timestamp: Date.now(), level, message });
    if (buffer.length > MAX_LINES) {
      buffer.splice(0, buffer.length - MAX_LINES);
    }
  }

  console.log = (...args: unknown[]) => {
    push('log', args);
    origLog(...args);
  };

  console.error = (...args: unknown[]) => {
    push('error', args);
    origError(...args);
  };

  console.warn = (...args: unknown[]) => {
    push('warn', args);
    origWarn(...args);
  };
}
