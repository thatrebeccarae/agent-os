import fs from 'node:fs';
import path from 'node:path';
import type { Tool } from '../agent/tools.js';
import { isBrowserConfigured, getBrowserTimeout } from './manager.js';
import { validateUrl } from './security.js';
import { getContext } from './manager.js';
import { wrapAndDetect } from '../security/content-boundary.js';

const WORKSPACE_DIR = path.resolve(process.cwd(), 'data', 'workspace');
const SCREENSHOTS_DIR = path.join(WORKSPACE_DIR, 'screenshots');
const MAX_TEXT_CHARS = 5000;
const MAX_LINKS = 20;
const MAX_ELEMENTS = 100;

async function withPage(
  url: string,
  fn: (page: import('patchright').Page) => Promise<string>,
  options?: { waitUntil?: 'load' | 'domcontentloaded' | 'networkidle'; errorPrefix?: string },
): Promise<string> {
  const check = await validateUrl(url);
  if (!check.valid) return `Error: ${check.reason}`;

  const ctx = await getContext();
  const page = await ctx.newPage();
  try {
    await page.goto(url, {
      waitUntil: options?.waitUntil ?? 'networkidle',
      timeout: getBrowserTimeout(),
    });
    return await fn(page);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const prefix = options?.errorPrefix ?? 'Error';
    return `${prefix} ${url}: ${msg}`;
  } finally {
    await page.close();
  }
}

export function getBrowserTools(): Tool[] {
  if (!isBrowserConfigured()) return [];

  return [
    // ── browser_navigate ──────────────────────────────────────────────
    {
      name: 'browser_navigate',
      description:
        'Navigate to a URL and extract page content. Returns page title, text content (first 5000 chars), ' +
        'and up to 20 links found on the page. Use wait_for to control when content is extracted.',
      input_schema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to navigate to' },
          wait_for: {
            type: 'string',
            enum: ['load', 'domcontentloaded', 'networkidle'],
            description: 'Wait condition (default: "networkidle")',
          },
        },
        required: ['url'],
      },
      handler: async (input) => {
        const url = input.url as string;
        const waitFor = (input.wait_for as 'load' | 'domcontentloaded' | 'networkidle') || 'networkidle';

        return withPage(url, async (page) => {
          const title = await page.title();
          let textContent = await page.evaluate(() =>
            document.body?.innerText?.slice(0, 5000) ?? '',
          );
          const links = await page.evaluate((max: number) => {
            const anchors = Array.from(document.querySelectorAll('a[href]'));
            return anchors.slice(0, max).map((a) => ({
              text: (a as HTMLAnchorElement).innerText.trim().slice(0, 100),
              href: (a as HTMLAnchorElement).href,
            }));
          }, MAX_LINKS);

          // Security: detect injection patterns and wrap external content
          textContent = wrapAndDetect(textContent, `webpage:${url}`);

          const linkLines = links
            .filter((l: { text: string; href: string }) => l.text || l.href)
            .map((l: { text: string; href: string }) => `  ${l.text || '(no text)'} → ${l.href}`)
            .join('\n');

          return [
            `Title: ${title}`,
            `\nContent (first ${MAX_TEXT_CHARS} chars):\n${textContent}`,
            links.length > 0 ? `\nLinks (${links.length}):\n${linkLines}` : '',
          ]
            .filter(Boolean)
            .join('\n');
        }, { waitUntil: waitFor, errorPrefix: 'Error navigating to' });
      },
    },

    // ── browser_screenshot ────────────────────────────────────────────
    {
      name: 'browser_screenshot',
      description:
        'Take a screenshot of a web page. Saves PNG to data/workspace/screenshots/. ' +
        'Returns file path and page title.',
      input_schema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to screenshot' },
          full_page: {
            type: 'boolean',
            description: 'Capture full scrollable page (default: false)',
          },
        },
        required: ['url'],
      },
      handler: async (input) => {
        const url = input.url as string;
        const fullPage = (input.full_page as boolean) ?? false;

        fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

        return withPage(url, async (page) => {
          const title = await page.title();
          const filename = `${Date.now()}.png`;
          const filepath = path.join(SCREENSHOTS_DIR, filename);
          await page.screenshot({ path: filepath, fullPage });

          return `Screenshot saved: screenshots/${filename}\nTitle: ${title}\nFull path: ${filepath}`;
        }, { errorPrefix: 'Error screenshotting' });
      },
    },

    // ── browser_extract ───────────────────────────────────────────────
    {
      name: 'browser_extract',
      description:
        'Extract structured data from a page using CSS selectors. Returns text content or attribute values ' +
        'for all matching elements (max 100). Use for tables, lists, specific page sections.',
      input_schema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to extract from' },
          selector: { type: 'string', description: 'CSS selector to match elements' },
          attribute: {
            type: 'string',
            description: 'Extract this attribute instead of text content (e.g., "href", "src")',
          },
        },
        required: ['url', 'selector'],
      },
      handler: async (input) => {
        const url = input.url as string;
        const selector = input.selector as string;
        const attribute = input.attribute as string | undefined;

        return withPage(url, async (page) => {
          const results = await page.evaluate(
            ({ sel, attr, max }: { sel: string; attr: string | null; max: number }) => {
              const elements = Array.from(document.querySelectorAll(sel));
              return elements.slice(0, max).map((el, i) => {
                const value = attr
                  ? el.getAttribute(attr) ?? ''
                  : (el as HTMLElement).innerText?.trim() ?? '';
                return `[${i + 1}] ${value.slice(0, 500)}`;
              });
            },
            { sel: selector, attr: attribute ?? null, max: MAX_ELEMENTS },
          );

          if (results.length === 0) {
            return `No elements found matching "${selector}" on ${url}`;
          }

          let extracted = results.join('\n');
          extracted = wrapAndDetect(extracted, `webpage:${url}`);

          return `Found ${results.length} element(s) matching "${selector}":\n\n${extracted}`;
        }, { errorPrefix: 'Error extracting from' });
      },
    },

    // ── browser_fill ──────────────────────────────────────────────────
    {
      name: 'browser_fill',
      description:
        'Interact with a web page: fill forms, click buttons, select options. ' +
        'Actions execute in sequence. Returns final page title and text content.',
      input_schema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to navigate to first' },
          actions: {
            type: 'string',
            description:
              'JSON array of actions. Types: ' +
              '{"type":"fill","selector":"...","value":"..."}, ' +
              '{"type":"click","selector":"..."}, ' +
              '{"type":"select","selector":"...","value":"..."}, ' +
              '{"type":"wait","ms":1000}',
          },
        },
        required: ['url', 'actions'],
      },
      handler: async (input) => {
        const url = input.url as string;
        const actionsRaw = input.actions as string;

        let actions: Array<{ type: string; selector?: string; value?: string; ms?: number }>;
        try {
          actions = JSON.parse(actionsRaw);
          if (!Array.isArray(actions)) throw new Error('actions must be an array');
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return `Error parsing actions JSON: ${msg}`;
        }

        return withPage(url, async (page) => {
          for (const action of actions) {
            switch (action.type) {
              case 'fill':
                if (!action.selector || action.value === undefined) {
                  return 'Error: fill action requires selector and value';
                }
                await page.fill(action.selector, action.value);
                break;
              case 'click':
                if (!action.selector) return 'Error: click action requires selector';
                await page.click(action.selector, { timeout: getBrowserTimeout() });
                break;
              case 'select':
                if (!action.selector || !action.value) {
                  return 'Error: select action requires selector and value';
                }
                await page.selectOption(action.selector, action.value);
                break;
              case 'wait':
                await page.waitForTimeout(Math.min(action.ms ?? 1000, 10_000));
                break;
              default:
                return `Error: unknown action type "${action.type}"`;
            }
          }

          const title = await page.title();
          let textContent = await page.evaluate(() =>
            document.body?.innerText?.slice(0, 5000) ?? '',
          );

          textContent = wrapAndDetect(textContent, `webpage:${url}`);

          return [
            `Executed ${actions.length} action(s) successfully.`,
            `Title: ${title}`,
            `\nContent (first ${MAX_TEXT_CHARS} chars):\n${textContent}`,
          ].join('\n');
        }, { errorPrefix: 'Error during browser interaction on' });
      },
    },

    // ── browser_monitor ───────────────────────────────────────────────
    {
      name: 'browser_monitor',
      description:
        'Check a web page for changes or specific content. Navigates to the URL, extracts text ' +
        '(optionally scoped to a CSS selector), and returns it for LLM analysis. ' +
        'Designed for recurring task queue checks.',
      input_schema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to monitor' },
          selector: {
            type: 'string',
            description: 'Optional CSS selector to scope content extraction',
          },
          description: {
            type: 'string',
            description: 'What to check for (context for the monitoring task)',
          },
        },
        required: ['url', 'description'],
      },
      handler: async (input) => {
        const url = input.url as string;
        const selector = input.selector as string | undefined;
        const description = input.description as string;

        return withPage(url, async (page) => {
          const title = await page.title();
          let content: string;

          if (selector) {
            content = await page.evaluate(
              ({ sel, max }: { sel: string; max: number }) => {
                const el = document.querySelector(sel);
                if (!el) return `(no element matching "${sel}")`;
                return (el as HTMLElement).innerText?.slice(0, max) ?? '';
              },
              { sel: selector, max: MAX_TEXT_CHARS },
            );
          } else {
            content = await page.evaluate((max: number) =>
              document.body?.innerText?.slice(0, max) ?? '',
            MAX_TEXT_CHARS);
          }

          content = wrapAndDetect(content, `webpage:${url}`);

          return [
            `Monitor check: ${description}`,
            `URL: ${url}`,
            `Title: ${title}`,
            selector ? `Selector: ${selector}` : null,
            `\nContent:\n${content}`,
          ]
            .filter(Boolean)
            .join('\n');
        }, { errorPrefix: 'Error monitoring' });
      },
    },
  ];
}
