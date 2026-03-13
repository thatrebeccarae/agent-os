# Contributing to Aouda

Thank you for your interest in contributing! This guide will help you get started.

## Development Setup

### Prerequisites

- **Node.js 22+** (required)
- **pnpm** (recommended) or npm
- A Telegram bot token ([create one via BotFather](https://t.me/BotFather))
- At least one LLM API key (Anthropic, OpenAI, or Google Gemini)

### Getting Started

```bash
# Clone the repo
git clone https://github.com/thatrebeccarae/aouda.git
cd aouda

# Install dependencies
pnpm install

# Copy environment config
cp .env.example .env
# Edit .env with your API keys and tokens

# Run in development mode (auto-reload)
pnpm dev

# Type-check without building
pnpm typecheck

# Build for production
pnpm build
```

### Optional Services

These are not required but enable additional capabilities:

- **Ollama** — Local LLM and embedding support
- **Gmail OAuth** — Email monitoring and management
- **Miniflux** — RSS feed monitoring
- **n8n** — Workflow automation
- **Docker** — Sandbox execution and service health monitoring

## Code Style

- **TypeScript** with strict mode enabled
- **ESM modules** — use `.js` extensions in imports (TypeScript resolves them)
- No semicolons (project uses the default prettier-compatible style — match existing files)
- Async/await preferred over raw Promises
- Descriptive variable and function names

### Project Structure

```
src/
├── agent/        # Agent loop, tools, system prompt
├── browser/      # Browser automation (Playwright, agent-browser)
├── channels/     # Messaging adapters (Telegram, Slack)
├── claude-code/  # Claude Code handoff, approvals, remote control
├── cli/          # CLI commands (setup, health)
├── config/       # Identity, quiet hours, configuration
├── docker/       # Docker sandbox and service monitoring
├── gateway/      # Message routing, session management
├── gmail/        # Gmail OAuth, client, tools
├── inbox/        # Proactive inbox monitoring
├── llm/          # Multi-provider LLM router
├── memory/       # Fact storage, search, extraction, embeddings
├── miniflux/     # RSS feed integration
├── n8n/          # Workflow automation integration
├── onboarding/   # First-run experience
├── scheduler/    # Background task scheduling
├── security/     # Content boundary wrapping, injection detection
└── twitter/      # Twitter/X browser-based automation
```

## Pull Request Process

1. **Fork the repo** and create a feature branch from `main`
2. **Make your changes** — keep PRs focused on a single concern
3. **Run type-checking**: `pnpm typecheck`
4. **Test your changes** manually with a Telegram bot
5. **Open a PR** with a clear description of what and why

### PR Guidelines

- Keep changes minimal and focused
- Update `.env.example` if adding new environment variables
- Add comments only where logic isn't self-evident
- No breaking changes without discussion in an issue first

## Security Requirements for New Tools

If you're adding a new tool, you **must** consider security:

### Content Boundary Wrapping

Any tool that fetches external data (APIs, web pages, email, RSS, webhooks) must wrap its output with content boundary markers:

```typescript
import { wrapExternalContent } from '../security/content-boundary.js';

// In your tool handler:
const result = await fetchExternalData();
return wrapExternalContent(result, 'your_tool_name');
```

### Security Tier Assignment

Every tool must declare its security tier:

- **`auto`** — Safe, read-only operations (searching, reading local files)
- **`approval`** — Actions that modify state or contact external services
- **`deny`** — Blocked by default (destructive operations)

### Input Validation

- Validate all tool inputs against the declared schema
- Sanitize file paths (prevent directory traversal)
- Validate URLs (use the existing SSRF protection)

## Reporting Issues

- **Bugs**: Open a GitHub issue with reproduction steps
- **Security vulnerabilities**: See [SECURITY.md](SECURITY.md) — do **not** use public issues
- **Feature requests**: Open a GitHub issue tagged `enhancement`

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
