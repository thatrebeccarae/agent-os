# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased] — v0.1.0

Initial pre-release. The agent has been running in production for the maintainer since January 2026.

### Added

- **Core agent loop** with multi-provider LLM routing (Anthropic, OpenAI, Gemini, Ollama) and automatic fallback
- **Telegram** primary interface with owner authentication and inline keyboard approvals
- **Slack** optional channel with user allowlisting
- **Gmail integration** — search, read, draft, archive, label (8 tools)
- **Google Calendar integration** — list, create, update, delete events, find free time (7 tools)
- **Browser automation** — Playwright-based navigation, extraction, screenshots, form filling, page monitoring (5 tools)
- **RSS/Miniflux integration** — search, browse, summarize feeds with scheduled morning digests (4 tools)
- **n8n workflow integration** — list, trigger, and monitor workflow executions (3 tools)
- **Web search** with multi-provider fallback (Brave, SearXNG, DuckDuckGo)
- **Background task queue** — schedule, track, and manage long-running work
- **Claude Code handoff** — delegate coding tasks to a local Claude Code agent with Telegram-based approval
- **Remote control** — start a Claude Code remote session on your server and get a shareable link via Telegram
- **Quiet hours** — configurable window to suppress non-urgent proactive notifications overnight
- **Docker health monitoring** with proactive Telegram alerts when containers go down
- **Dashboard** — web UI with status overview, log viewer, and integrity checking
- **Heartbeat** — self-monitoring loop that detects anomalies and alerts the operator
- **Skills framework** — drop-in plugin system (`skills/` directory)
- **Configurable personality** via `soul.md` (voice, values, boundaries)
- **Vault integration** — read/write/search an Obsidian vault or any file tree
- **Security: content boundaries** — all external data wrapped in security markers to prevent injection
- **Security: injection detection** — pattern-based detection with automatic heightened security mode
- **Security: 4-layer Bash permissions** — blocked patterns, heightened security, safe prefixes, Telegram approval
- **Security: SSRF protection** — fail-closed DNS validation for outbound requests
- **Security: sandbox** — Docker-based and lightweight command execution with allowlists
- **Security: OAuth token redaction** in logs and LLM context
- **42 tools** across core, Gmail, Calendar, browser, RSS, n8n, and infrastructure
- **9,500 lines of TypeScript** across 60 files (ESM, Node >= 22)
