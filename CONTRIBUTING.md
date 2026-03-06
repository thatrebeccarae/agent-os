# Contributing to Aouda

## Development Setup

### Prerequisites

- Node.js >= 22
- pnpm
- A Telegram bot token (from [BotFather](https://t.me/BotFather))
- At least one LLM provider API key (Anthropic, OpenAI, or Gemini)

### Getting Started

```bash
git clone https://github.com/<your-fork>/aouda.git
cd aouda
pnpm install
cp .env.example .env
# Edit .env — set TELEGRAM_BOT_TOKEN and at least one LLM API key
```

Run in development mode (auto-restarts on file changes):

```bash
pnpm dev
```

Run the type checker before submitting any changes:

```bash
pnpm typecheck
```

Build for production:

```bash
pnpm build
pnpm start
```

---

## Code Standards

- **TypeScript strict mode** is enabled. No `any` unless absolutely unavoidable and documented.
- **ESM with Node16 module resolution.** All local imports must use the `.js` extension, even when the source file is `.ts`. This is a TypeScript/Node16 requirement.
- **No default exports.** Use named exports everywhere.
- **Explicit error handling.** Never swallow errors silently. Catch, log, and either re-throw or return a meaningful error string.
- **Security: content boundaries on all external data.** Any data from emails, web pages, RSS feeds, webhooks, or user messages that gets injected into prompts must be wrapped in content boundary markers so the LLM treats it as data, not instructions.
- **Validate file paths.** Use the path validation helpers in `src/agent/tools.ts` (e.g., `resolveWorkspacePath`, `resolveVaultReadPath`). Never construct file paths from user input without validation.
- **No `eval`, `Function()`, or dynamic code execution.**

---

## Adding a Tool

Tools are the primary way the agent interacts with the world. Each tool is registered as a side effect at module load time.

Use `register()` from `src/agent/tools.ts`:

```typescript
import { register } from '../agent/tools.js';

register({
  name: 'my_tool',
  description: 'One-line description for the LLM to understand when to use this tool.',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The search query' },
    },
    required: ['query'],
  },
  handler: async (input: Record<string, unknown>, context: ToolContext) => {
    const query = input.query as string;
    // Do work, return a string result.
    return `Result for: ${query}`;
  },
});
```

Key points:

- **Handler signature:** `(input: Record<string, unknown>, context: ToolContext) => Promise<string>`. The `context` object carries `sessionId` for session-aware operations.
- **Return a string.** The return value is sent back to the LLM as the tool result.
- **Side-effect registration.** Importing the module registers the tool. Make sure your module is imported from `src/agent/tools.ts` or `src/index.ts`.
- **Conditional registration.** If your tool depends on an optional API key, check for it before registering (see the Gmail/Calendar/Miniflux patterns in `tools.ts`).

---

## Adding a Skill

Skills are the plugin system. They live in the `skills/` directory and are loaded dynamically at startup.

Create a new `.ts` file in `skills/`:

```typescript
import { register as registerTool } from '../src/agent/tools.js';
import type { SkillManifest } from '../src/skills/loader.js';

export const manifest: SkillManifest = {
  name: 'my-skill',
  description: 'What this skill does',
  version: '1.0.0',
  tools: ['my_skill_tool'],
};

export function register(): void {
  registerTool({
    name: 'my_skill_tool',
    description: 'Tool description for the LLM',
    input_schema: {
      type: 'object',
      properties: {
        input: { type: 'string', description: 'Some input' },
      },
      required: ['input'],
    },
    handler: async (input) => {
      return `Result: ${input.input}`;
    },
  });
}
```

Rules:

- Export both `manifest` and `register()`. Both are required.
- Use `import { register as registerTool }` to avoid colliding with your own `register` export.
- List all tool names in `manifest.tools`.
- One broken skill does not crash the agent. Errors are caught and logged.
- Skills load after core tools, so they can depend on `toolRegistry`.
- Disable all skills by setting `SKILLS_ENABLED=false`. Override the skills directory with `SKILLS_DIR=/path/to/dir`.

---

## Adding a Channel

Channels connect the agent to messaging platforms. Implement the `ChannelAdapter` interface from `src/channels/types.ts`:

```typescript
export interface ChannelAdapter {
  type: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  sendMessage(msg: OutboundMessage): Promise<void>;
  onMessage(handler: (msg: InboundMessage) => Promise<void>): void;
}
```

Then register it in `src/index.ts` via `gateway.registerChannel()`.

Session IDs follow the format `"channelType:channelId"` (e.g., `"telegram:123456789"`). Your channel adapter must construct `InboundMessage` objects with the correct `channelType` and `channelId` so routing works.

---

## Adding an LLM Provider

LLM providers live in `src/llm/`. Each provider implements the `LLMProvider` interface:

```typescript
export interface LLMProvider {
  name: string;
  call(
    messages: LLMMessage[],
    systemPrompt: string,
    tools?: LLMToolDefinition[],
  ): Promise<LLMResponse>;
}
```

Steps:

1. Create a new file in `src/llm/` (e.g., `src/llm/my-provider.ts`).
2. Implement the provider, normalizing responses to `LLMResponse`.
3. Add the provider to the tier routing in `src/llm/router.ts`. The router uses a tiered fallback system: `local`, `cheap`, `capable`, `max`.
4. Guard on the relevant API key so the provider is only available when configured.

---

## Security Requirements for PRs

Every PR that touches tool handlers, external data ingestion, or channel adapters must meet these requirements:

- **Content boundaries.** External data (emails, web content, RSS items, webhook payloads, Slack messages) must be wrapped in content boundary markers before being included in LLM prompts. This prevents prompt injection.
- **Path validation.** File operations must use the path validation functions (`resolveWorkspacePath`, `resolveVaultReadPath`, `resolveVaultWritePath`). Direct `fs` calls with unvalidated paths are not accepted.
- **Threat model.** New tools must include a brief comment or PR description noting what untrusted input the tool processes and how it is sanitized.
- **No credentials in output.** API keys, tokens, and secrets must never appear in logs, tool results, or LLM responses.

---

## Pull Request Process

1. Fork the repository and create a feature branch.
2. Implement your change. Keep it focused -- one feature or fix per PR.
3. Run `pnpm typecheck` and fix all errors.
4. Open a PR with a clear description of:
   - What the change does.
   - Why it is needed.
   - Security implications (if any).
5. If adding a new tool or skill, include an example of expected input/output.
