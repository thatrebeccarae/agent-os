# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Vector memory system with hybrid FTS5 + semantic search (Phase 27)
- Onboarding wizard and health check CLI (Phase 23)

## [1.0.0] - 2026-03-13

### Added

#### Core Agent
- Agent loop with configurable iteration limits (10 background, 25 interactive)
- Multi-provider LLM router with automatic failover (Anthropic, OpenAI, Gemini, Ollama)
- Tier detection: auto-escalates complex queries to capable models
- Rate limit retry with exponential backoff (30s, 60s) before provider cascade
- 56 tools across 10 domains

#### Communication
- Telegram channel with long polling, inline keyboards, and typing indicators
- Slack channel with Socket Mode and @mention support
- Per-session message serialization (prevents out-of-order processing)

#### Memory & Intelligence
- SQLite-backed fact storage with FTS5 full-text search
- Automatic memory extraction every 5 turns (fire-and-forget)
- Fact categorization: preference, fact, context, instruction
- Memory injection into system prompt as relevant context

#### Email
- Gmail integration with OAuth2 (multi-account: primary + secondary)
- 8 email tools: search, read, read_thread, list_labels, label, archive, create_draft, get_profile
- Email best practices in system prompt (list labels first, search by subject, reversible actions)

#### Calendar
- Google Calendar integration (7 tools)
- Event creation, updates, deletion, and free time queries

#### Browser
- Playwright-based browser automation (6 tools: navigate, screenshot, extract, fill, monitor)
- Agent-browser integration (Vercel agent-browser) with semantic locators
- Patchright persistent browser sessions for Twitter automation

#### Twitter/X
- 15 browser-based Twitter tools (post, reply, repost, like, follow, search, notifications)
- Persistent login via browser profile cookies
- Post logging and metrics tracking in SQLite

#### Proactive Monitoring
- Inbox monitor: polls Gmail every 30 minutes, urgency-based triage
- Docker service health checks every 15 minutes
- Heartbeat self-review every 30 minutes
- RSS digest via Miniflux (daily at 7 AM)
- Quiet hours support (configurable, suppresses non-urgent notifications overnight)
- Google Drive access requests filtered from inbox

#### Workflow Integration
- n8n workflow automation (list, trigger by name, execution status)
- Miniflux RSS reader (search, feeds, recent entries, mark read)
- Webhook receiver with bearer token auth

#### Task System
- Background task queue with 5-minute timeout
- Task creation, status tracking, and cancellation
- Results routed back to operator via messaging channel

#### Claude Code Integration
- Handoff tool with repo aliases and path resolution
- Three-layer bash command approval (auto-deny, auto-approve, Telegram approval)
- Remote Control: spawns Claude Code remote sessions, sends link via Telegram

#### Mobile UX
- Natural language resolution (vault paths, date awareness, repo aliases)
- Tool descriptions rewritten for LLM chaining patterns
- Tier detection via imperative verbs, domain nouns, question marks

#### Configuration
- Centralized identity constants (agent name, operator name, paths, repo aliases)
- Environment-variable-driven configuration
- Configurable quiet hours, monitor intervals, iteration limits

### Security
- Content boundary wrapping on all external content (Gmail, web, RSS, calendar, n8n, browser)
- 10 prompt injection patterns detected with Unicode homoglyph normalization (28 mappings)
- SSRF protection: blocks internal IPs, dangerous protocols, decimal/octal obfuscation
- Docker sandbox: ephemeral containers, `--network none`, `--cap-drop ALL`, `:ro` mounts
- File system sandboxing with directory allowlists (vault reads, restricted writes)
- Dashboard bearer token auth with timing-safe comparison
- Rate limiting: 10 req/min webhook, 60 req/min dashboard per IP
- Log scrubbing: API key prefixes, bearer tokens, keyword-adjacent secrets
- Express server bound to 127.0.0.1 (localhost only)
- 15+ blocked bash patterns (rm -rf, force push, curl, wget, nmap, etc.)
- Newline injection defense in bash pattern matching

### Infrastructure
- Sync script for private → public repo (file copy, text scrubbing, leak detection)
- LaunchAgent daemonization support
- Playwright-chromium made optional (dynamic import with availability check)
- `.env.example` with organized sections and documentation
