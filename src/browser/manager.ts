import { createRequire } from 'node:module';

// Playwright types — loaded dynamically so the package is optional
type Browser = import('playwright-chromium').Browser;
type BrowserContext = import('playwright-chromium').BrowserContext;

// ── Playwright availability ────────────────────────────────────────

let _playwrightAvailable: boolean | null = null;

/** Check if playwright-chromium is installed. Caches the result. */
export async function isPlaywrightAvailable(): Promise<boolean> {
  if (_playwrightAvailable !== null) return _playwrightAvailable;
  try {
    await import('playwright-chromium');
    _playwrightAvailable = true;
  } catch {
    _playwrightAvailable = false;
  }
  return _playwrightAvailable;
}

/**
 * Synchronous check — returns cached result or attempts require.resolve.
 * Use in contexts where async isn't possible (e.g. tool registration).
 */
export function isPlaywrightAvailableSync(): boolean {
  if (_playwrightAvailable !== null) return _playwrightAvailable;
  try {
    const require = createRequire(import.meta.url);
    require.resolve('playwright-chromium');
    _playwrightAvailable = true;
  } catch {
    _playwrightAvailable = false;
  }
  return _playwrightAvailable;
}

// ── Browser config ──────────────────────────────────────────────────

export function isBrowserConfigured(): boolean {
  if (process.env.BROWSER_ENABLED === 'false') return false;
  return isPlaywrightAvailableSync();
}

export function getBrowserTimeout(): number {
  return Number(process.env.BROWSER_TIMEOUT_MS) || 30_000;
}

export function getAllowedDomains(): string[] | null {
  const raw = process.env.BROWSER_ALLOWED_DOMAINS;
  if (!raw) return null; // null = all domains allowed
  return raw.split(',').map((d) => d.trim()).filter(Boolean);
}

// ── Browser instance management ─────────────────────────────────────

let _browser: Browser | null = null;

export async function getBrowser(): Promise<Browser> {
  if (!_browser || !_browser.isConnected()) {
    const { chromium } = await import('playwright-chromium');
    _browser = await chromium.launch({ headless: true });
  }
  return _browser;
}

export async function createContext(): Promise<BrowserContext> {
  const browser = await getBrowser();
  return browser.newContext({
    userAgent: 'PersonalAgent/1.0 (personal assistant)',
    viewport: { width: 1280, height: 720 },
    locale: 'en-US',
  });
}

export async function closeBrowser(): Promise<void> {
  if (_browser) {
    await _browser.close();
    _browser = null;
  }
}
