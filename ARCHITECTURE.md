# Architecture

Aouda is a single-user, security-first personal AI agent built in TypeScript. 42 tools across 60 files, 9,500 lines of code, 11 production dependencies. This document describes the system architecture, component responsibilities, data flow, security layers, and the full tool inventory.

---

## System Overview

```
┌───────────────────────────────────────────────────────────────────────────┐
│                           OPERATOR                                       │
│                    (Telegram / Slack)                                     │
└──────────────┬────────────────────────────────────────────────────────────┘
               │
               ▼
┌──────────────────────────┐     ┌──────────────────────────┐
│      Channel Adapters     │     │      Health Server        │
│   Telegram  ·  Slack      │     │   Express (127.0.0.1)     │
│   User allowlists         │     │   Dashboard · Webhooks    │
└──────────────┬────────────┘     └──────────────┬───────────┘
               │                                  │
               ▼                                  ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                            GATEWAY                                       │
│              Message routing · Session management                        │
└──────────────┬───────────────────────────────────────────────────────────┘
               │
               ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                          AGENT LOOP                                      │
│     System prompt (soul.md) · Tool dispatch · Max 10 iterations          │
│                                                                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐       │
│  │  LLM Router   │  │   Memory      │  │   Content Boundaries     │       │
│  │  4 providers   │  │   SQLite FTS5 │  │   wrapAndDetect()        │       │
│  │  Tier routing  │  │   Fact extract │  │   Injection detection    │       │
│  └──────────────┘  └──────────────┘  └──────────────────────────┘       │
└──────────────┬───────────────────────────────────────────────────────────┘
               │
               ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                           TOOLS (42)                                     │
│                                                                          │
│  Core (15)     Gmail (8)     Calendar (7)    Browser (5)                 │
│  Miniflux (4)  n8n (3)       Claude Code (3) Tasks (4)                  │
│  Vault (3)                                                               │
└──────────────┬───────────────────────────────────────────────────────────┘
               │
               ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                       SECURITY LAYER                                     │
│                                                                          │
│  Content boundaries (all external data) · Injection detection            │
│  4-layer Bash permissions · 2-tier sandbox (lightweight + Docker)        │
│  SSRF protection · Path validation · Credential redaction                │
└──────────────────────────────────────────────────────────────────────────┘
               │
               ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                      BACKGROUND SERVICES                                 │
│                                                                          │
│  Task queue (SQLite)  ·  Scheduler  ·  Worker                            │
│  Inbox monitor (Gmail, 30min)  ·  Docker monitor (15min)                 │
│  Calendar monitor (15min)  ·  Heartbeat self-review (30min)              │
│  RSS morning digest (daily)  ·  Integrity checker                        │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## Components

### Channel Adapters (`src/channels/`)

Two messaging channels, both with per-user allowlists:

- **Telegram** (`telegram.ts`) -- Primary interface. grammY framework. Inline keyboard support for Claude Code approval flows. Owner chat ID enables proactive notifications.
- **Slack** (`slack.ts`) -- Optional. Bolt framework with Socket Mode. User allowlisting via Slack user IDs.

Both adapters implement the `ChannelAdapter` interface: `start()`, `stop()`, `sendMessage()`, `onMessage()`.

### Gateway (`src/gateway/`)

- **Router** (`router.ts`) -- Routes inbound messages to the agent loop, manages session IDs (`channelType:channelId`), handles message threading.
- **Health Server** (`server.ts`) -- Express on `127.0.0.1:3210`. Serves the dashboard UI, log viewer, webhook endpoint, and OAuth callback. Bearer token auth for webhooks with timing-safe comparison.

### Agent Loop (`src/agent/`)

- **Loop** (`loop.ts`) -- Single-layer agent loop: build system prompt, call LLM, dispatch tool, repeat. Max 10 iterations per turn. Cleanity, auditable.
- **Prompt** (`prompt.ts`) -- Constructs the system prompt from `soul.md` personality, memory context, recent facts, tool descriptions, and security instructions.
- **Tools** (`tools.ts`) -- Tool registry. All 42 tools registered via `register()` at module load time. Conditional registration based on available API keys.

### LLM Router (`src/llm/`)

Four providers with tier-based routing and automatic fallback:

| Tier | Purpose | Default provider |
|------|---------|-----------------|
| `local` | Simple queries, no API cost | Ollama |
| `cheap` | Background tasks, fact extraction | Gemini Flash / GPT-4o Mini |
| `capable` | Standard conversations | Claude Sonnet / GPT-4o |
| `max` | Complex reasoning | Claude Opus |

Each provider normalizes responses to the shared `LLMResponse` type. If the primary provider for a tier fails, the router falls back through the chain.

### Memory (`src/memory/`)

- **Store** (`store.ts`) -- SQLite-backed conversation history. Per-session message storage with TTL.
- **Search** (`search.ts`) -- FTS5 full-text search over stored facts.
- **Extract** (`extract.ts`) -- Automatic fact extraction from conversations. Fire-and-forget via the `cheap` LLM tier. Extracted facts tagged with source (conversation vs. external content).

### Security (`src/security/`)

- **Content Boundaries** (`content-boundary.ts`) -- `wrapAndDetect()` wraps all external data in random-ID boundary markers before it reaches the LLM. Includes Unicode homoglyph normalization (fullwidth brackets, guillemets, CJK brackets) and 10-pattern injection detection. Detections trigger operator alerts and 30-minute heightened security mode.

See `SECURITY.md` for the full threat model, defense inventory, and OWASP ASI mapping.

### Sandbox (`src/sandbox/`)

Two-tier command execution:

- **Lightweight** (`lightweight.ts`) -- Allow-listed commands (`ls`, `cat`, `grep`, `git`, `jq`, `find`, `sort`, `diff`), shell metacharacter rejection, workspace-restricted execution, 30-second timeout.
- **Docker** (`docker.ts`) -- Ephemeral containers with `--cap-drop ALL`, `--security-opt no-new-privileges`, `--read-only`, `--network none`, 512MB memory limit. Auto-deleted after execution.

The **Executor** (`executor.ts`) routes commands to the appropriate tier. If Docker is unavailable and a command isn't in the allow-list, execution is rejected (fail-closed).

### Claude Code Integration (`src/claude-code/`)

- **Executor** (`executor.ts`) -- Delegates coding tasks to a local Claude Code instance via the Anthropic Agent SDK. 4-layer Bash permission system: blocked patterns (auto-deny), heightened security (all to Telegram), safe prefixes (auto-approve), Telegram approval.
- **Approvals** (`approvals.ts`) -- Telegram inline keyboard approval flow. 30-minute timeout with auto-deny.
- **Remote Control** (`remote.ts`) -- Starts a Claude Code remote session on the server and sends the operator a shareable link via Telegram.

### Background Services

- **Task Queue** (`src/tasks/queue.ts`) -- SQLite-backed priority queue with atomic claiming and status tracking.
- **Worker** (`src/tasks/worker.ts`) -- Background worker that processes queued tasks, routes results back to the operator's session.
- **Scheduler** (`src/tasks/scheduler.ts`) -- Interval-based scheduling for proactive monitors and recurring tasks.
- **Inbox Monitor** (`src/inbox/monitor.ts`) -- Gmail inbox check every 30 minutes. Urgency classification, triage digest.
- **Docker Monitor** (`src/inbox/docker-monitor.ts`) -- Container health check every 15 minutes. Alerts when containers go down (bypasses quiet hours).
- **Calendar Monitor** (`src/inbox/calendar-monitor.ts`) -- Upcoming event alerts, 30-minute pre-meeting notifications, morning digest.
- **Heartbeat** (`src/heartbeat/monitor.ts`) -- Self-review loop every 30 minutes. Detects anomalies in agent behavior and alerts the operator.
- **RSS Digest** (`src/miniflux/digest.ts`) -- Daily morning digest from Miniflux RSS feeds.
- **Integrity Checker** (`src/dashboard/integrity.ts`) -- Periodic verification of system state consistency.

### Dashboard (`src/dashboard/`)

Web UI served on `127.0.0.1:3210`. Includes status overview, active tasks, session viewer, log buffer, and integrity check results. No authentication required because it only binds to localhost.

### Skills Framework (`src/skills/`)

Drop-in plugin system. Skills are `.ts` files in the `skills/` directory that export a `manifest` and a `register()` function. Loaded dynamically at startup. One broken skill does not crash the agent.

No remote skill registry. No marketplace. Skills are local files, vetted and loaded at boot. This is a deliberate architectural decision -- see `SECURITY.md` for the rationale.

---

## Tool Inventory (42 tools)

### Core Utilities (15)

| Tool | Description |
|------|-------------|
| `get_current_time` | Current date and time in ISO 8601 |
| `web_search` | Multi-provider web search (Brave, SearXNG, DuckDuckGo) with automatic fallback |
| `read_file` | Read a file from the workspace directory |
| `write_file` | Write content to a file in the workspace directory |
| `vault_read` | Read a file from the Obsidian vault |
| `vault_write` | Write to safe vault paths (Inbox, Projects, Daily, Meetings) |
| `vault_search` | Search vault files by filename pattern |
| `run_command` | Execute a shell command through the sandbox |
| `create_task` | Queue a background task with priority |
| `list_tasks` | List tasks by status |
| `get_task` | Get full task details including output |
| `cancel_task` | Cancel a pending task |
| `handoff_to_claude_code` | Delegate coding tasks to Claude Code with approval flow |
| `start_remote_session` | Start a Claude Code remote session, get shareable link |
| `stop_remote_session` | Stop an active remote session |

### Gmail (8)

| Tool | Description |
|------|-------------|
| `gmail_get_profile` | Get email address and account info |
| `gmail_list_labels` | List all Gmail labels |
| `gmail_search` | Search emails with Gmail query syntax |
| `gmail_read` | Read a specific email by ID |
| `gmail_read_thread` | Read an entire email thread |
| `gmail_create_draft` | Create a draft email (draft-first -- never sends without explicit request) |
| `gmail_archive` | Archive an email |
| `gmail_label` | Add or remove labels from an email |

### Google Calendar (7)

| Tool | Description |
|------|-------------|
| `calendar_list` | List available calendars |
| `calendar_events` | List events in a date range |
| `calendar_get_event` | Get full event details |
| `calendar_create_event` | Create a calendar event |
| `calendar_update_event` | Update an existing event |
| `calendar_delete_event` | Delete an event |
| `calendar_free_time` | Find free time slots in a date range |

### Browser Automation (5)

| Tool | Description |
|------|-------------|
| `browser_navigate` | Navigate to a URL and return page content. SSRF-protected. |
| `browser_screenshot` | Take a screenshot of the current page |
| `browser_extract` | Extract structured data from a page using CSS selectors |
| `browser_fill` | Fill form fields and interact with page elements |
| `browser_monitor` | Monitor a page for changes over time |

### Miniflux RSS (4)

| Tool | Description |
|------|-------------|
| `rss_search` | Search RSS feed entries by keyword |
| `rss_feeds` | List subscribed feeds |
| `rss_recent` | Get recent entries across all feeds |
| `rss_mark_read` | Mark entries as read |

### n8n Workflows (3)

| Tool | Description |
|------|-------------|
| `n8n_list_workflows` | List available n8n workflows |
| `n8n_trigger_workflow` | Trigger a workflow by name |
| `n8n_execution_status` | Check execution status of a workflow run |

---

## Data Flow

A message from Telegram to tool execution follows this path:

```
1. Telegram delivers message to grammY bot
2. Channel adapter checks user allowlist → reject if unauthorized
3. Gateway receives InboundMessage, resolves session ID
4. Agent loop builds system prompt:
   - soul.md personality
   - Memory context (recent conversation + relevant facts)
   - Tool descriptions (42 tools)
   - Security instructions
5. LLM Router selects provider based on tier configuration
6. LLM returns response (text and/or tool calls)
7. For each tool call:
   a. Tool handler executes
   b. External data wrapped in content boundaries (wrapAndDetect)
   c. Injection patterns checked → heightened security if detected
   d. Result returned to LLM for next iteration
8. After final iteration, response sent back through Gateway → Channel → Operator
```

For background tasks, the path diverges at step 7: the task is queued in SQLite and the Worker processes it asynchronously, routing results back to the operator's session when complete.

---

## Security Layers

```
┌─────────────────────────────────────────────────────┐
│  Layer 1: Channel Authentication                     │
│  Per-user allowlists (Telegram IDs, Slack IDs)       │
├─────────────────────────────────────────────────────┤
│  Layer 2: Content Boundaries                         │
│  wrapAndDetect() on all external data paths          │
│  Random-ID markers · Homoglyph normalization         │
├─────────────────────────────────────────────────────┤
│  Layer 3: Injection Detection                        │
│  10-pattern matcher · Heightened security mode       │
│  Operator alerts · 30-min auto-expire                │
├─────────────────────────────────────────────────────┤
│  Layer 4: Command Permissions                        │
│  Blocked patterns (auto-deny) · Safe prefixes        │
│  Telegram approval · Heightened security override    │
├─────────────────────────────────────────────────────┤
│  Layer 5: Sandbox Execution                          │
│  Lightweight (allow-list) · Docker (--network none)  │
│  Path validation · Symlink detection                 │
├─────────────────────────────────────────────────────┤
│  Layer 6: Network Protection                         │
│  SSRF defense · DNS rebinding protection             │
│  Protocol allowlist · Private IP blocking            │
├─────────────────────────────────────────────────────┤
│  Layer 7: Credential Protection                      │
│  .env storage · In-memory OAuth · Log scrubbing      │
│  Token redaction in responses                        │
└─────────────────────────────────────────────────────┘
```

See `SECURITY.md` for the full defense inventory and OWASP ASI mapping.
