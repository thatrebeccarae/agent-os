# Security

Aouda is a personal AI agent with real capabilities: file I/O, command execution, browser automation, email access, and code generation. This document describes the security model, threat model, and defense mechanisms in detail.

## Security Model

Aouda is designed as a **single-user, single-operator** system. The operator (you) is the only trusted principal. Everything else is untrusted:

- Incoming emails
- Web pages and search results
- Calendar event descriptions
- RSS feed content
- Webhook payloads from n8n or other automation
- Slack/Telegram messages from non-allowlisted users

The agent sits at the intersection of an LLM and real-world actuators. It can read and write files, execute shell commands, browse the web, send emails, and delegate coding tasks to a sub-agent. Security is not a feature — it is a structural requirement.

### Trust Boundaries

```
┌─────────────────────────────────────────────────┐
│  TRUSTED                                        │
│  - Operator (Telegram/Slack allowlisted user)   │
│  - Local filesystem (within sandbox bounds)     │
│  - Configuration (.env, identity.ts)            │
└───────────────────────┬─────────────────────────┘
                        │
              ┌─────────▼─────────┐
              │  AGENT CORE       │
              │  LLM + Tools      │
              └─────────┬─────────┘
                        │
┌───────────────────────▼─────────────────────────┐
│  UNTRUSTED                                      │
│  - Email content          - RSS feeds           │
│  - Web pages              - Calendar events     │
│  - Webhook payloads       - Search results      │
│  - Browser page content   - Any external text   │
└─────────────────────────────────────────────────┘
```

## Threat Model

### 1. Prompt Injection

**Vector:** An attacker embeds instructions in email subjects, web pages, calendar event descriptions, RSS articles, or webhook payloads. The agent processes this content, and the LLM interprets the embedded instructions as its own.

**Impact:** The agent could be tricked into executing commands, exfiltrating data, modifying files, or sending messages on the operator's behalf.

### 2. Command Injection

**Vector:** Malicious input reaches a shell command via tool arguments — either through the agent's own `run_command` tool or through the Claude Code sub-agent's Bash tool.

**Impact:** Arbitrary command execution on the host system.

### 3. Server-Side Request Forgery (SSRF)

**Vector:** The agent's browser or HTTP tools are directed to internal network addresses (localhost, private IP ranges, cloud metadata endpoints) via attacker-controlled URLs in emails, calendar events, or web content.

**Impact:** Access to internal services, credential theft from cloud metadata, port scanning.

### 4. Credential Leakage

**Vector:** API keys, OAuth tokens, or secrets appear in LLM responses, tool output, logs, or error messages.

**Impact:** Account compromise, unauthorized API access.

### 5. Path Traversal

**Vector:** File read/write tool arguments contain `../` sequences or symlinks that escape the intended sandbox directory.

**Impact:** Reading or overwriting arbitrary files on the host.

### 6. Unauthorized Access

**Vector:** Unauthenticated requests to the dashboard, webhook endpoints, or OAuth callback.

**Impact:** Task injection, state inspection, CSRF-based OAuth token theft.

## Defense Inventory

### a. Content Boundaries

**File:** `src/security/content-boundary.ts`

All external content is wrapped with cryptographically tagged boundary markers before it reaches the LLM context:

```
<<<EXTERNAL_UNTRUSTED_CONTENT id="a1b2c3d4e5f6g7h8" source="email_triage">>>
[untrusted content here]
<<<END_EXTERNAL_UNTRUSTED_CONTENT>>>
```

The markers instruct the LLM to treat everything inside as data, not instructions. Each boundary includes a random 16-hex-character ID and a source label for audit tracing.

**Marker sanitization:** Before wrapping, any existing boundary-like markers in the untrusted content are replaced with `[MARKER_SANITIZED]`. This includes detection of Unicode homoglyph evasion — fullwidth angle brackets, guillemets, CJK brackets, mathematical brackets, and other visually similar characters are normalized to ASCII before marker detection.

**Applied to:** email triage, RSS digests, web search results, n8n webhook payloads, browser page content, calendar events.

### b. Injection Detection and Response

**File:** `src/security/content-boundary.ts` — `wrapAndDetect()` function

Pattern matching detects known prompt injection signatures in external content:

- "ignore previous instructions"
- "you are now"
- "system prompt"
- "disregard previous"
- "new instructions"
- "forget your rules"
- "override instructions"
- "act as a/an/if"
- "pretend to be"
- "do not follow your"

When injection patterns are detected:

1. A `SECURITY WARNING` is prepended inside the content boundary, listing matched patterns.
2. The registered callback alerts the operator (via Telegram/Slack).
3. **Heightened security mode** activates for the session: for 30 minutes, all Claude Code Bash commands bypass auto-approve and route to manual human approval — even commands that would normally be auto-approved as safe.

### c. Four-Layer Bash Permissions

**File:** `src/claude-code/executor.ts`

The Claude Code sub-agent can execute shell commands. Every Bash invocation passes through four layers:

| Layer | Name | Behavior |
|-------|------|----------|
| 1 | Blocked patterns | Auto-deny. `rm -rf /`, `git push --force main`, `curl`, `wget`, `socat`, `telnet`, `nmap`, nested `bash -c` with network tools. Never reaches the operator. |
| 1.5 | Heightened security | When active (post-injection-detection), ALL Bash commands route to Telegram for manual approval. Overrides Layer 2. |
| 2 | Safe prefixes | Auto-approve read-only commands: `ls`, `cat`, `grep`, `git log`, `git status`, `git diff`, `jq`, etc. Word-boundary checked to prevent `cat` matching `catalog`. |
| 3 | Human approval | Everything else goes to the operator via Telegram inline keyboard (Approve/Deny buttons). |

File-operation tools (`Read`, `Edit`, `Write`, `Glob`, `Grep`) are pre-approved in the SDK `allowedTools` list. Bash is intentionally excluded so it always routes through the permission layers.

### d. Command Sandbox

**Files:** `src/sandbox/executor.ts`, `src/sandbox/lightweight.ts`, `src/sandbox/docker.ts`

The agent's own `run_command` tool executes in a two-tier sandbox:

**Tier 1 — Lightweight sandbox** (`src/sandbox/lightweight.ts`):
- Command allow-list: `ls`, `cat`, `head`, `tail`, `grep`, `git`, `jq`, `find`, `sort`, `diff`, etc.
- Shell metacharacter rejection: pipes (`|`), semicolons (`;`), command substitution (`$()`), backticks, redirects, `&&`, `||` are all blocked.
- Execution in `data/workspace/` with restricted `HOME` and `PATH`.
- 30-second timeout, 10KB output limit.

**Tier 2 — Docker sandbox** (`src/sandbox/docker.ts`):
- Commands not in the allow-list or matching dangerous patterns route to Docker.
- Container runs with: `--cap-drop ALL`, `--security-opt no-new-privileges`, `--read-only` root filesystem, `--network none` (no network by default), `--memory 512m`, `--cpus 0.5`.
- Workspace bind-mounted to `/workspace`.
- Writable `/tmp` only (100MB tmpfs).
- 60-second timeout, 10KB output limit.
- Auto-deleted (`--rm`) after execution.

If Docker is unavailable and a command is not in the lightweight allow-list, execution is rejected.

### e. SSRF Protection

**File:** `src/browser/security.ts`

All URLs are validated before browser navigation or HTTP requests:

- **Protocol allowlist:** Only `http:` and `https:`. Blocks `file:`, `javascript:`, `data:`, `ftp:`, `blob:`.
- **Hostname blocklist:** `localhost`, `127.0.0.1`, `0.0.0.0`, `[::1]`.
- **Private IP range detection:** `10.x.x.x`, `172.16-31.x.x`, `192.168.x.x`, `169.254.x.x` (link-local).
- **IP encoding evasion prevention:** Decimal notation (`2130706433`), octal notation (`0177.0.0.1`).
- **IPv6 coverage:** Loopback (`::1`, `::`), IPv4-mapped (`::ffff:127.0.0.1`), link-local (`fe80::`), unique local (`fc00::/7`).
- **DNS rebinding protection:** After hostname validation, the resolved IP is checked against private ranges. If DNS resolution fails, the request is denied (fail-closed).
- **Domain allowlist:** Optional configuration to restrict browser navigation to a specific set of domains.

### f. Path Validation

**File:** `src/agent/tools.ts`

File operations are sandboxed to specific directories:

**Workspace files** (`data/workspace/`):
- All paths resolved to absolute, then checked against the workspace prefix.
- Symlink traversal detection: `fs.realpath()` resolves the true path, which is re-checked against the workspace boundary.

**Vault files** (configurable via `VAULT_BASE_PATH`):
- Read access to the entire vault.
- Write access restricted to specific safe prefixes: `01-Inbox/`, `02-Projects/`, `06-Daily/`, `07-Meetings/`.
- Same symlink traversal detection as workspace files.

### g. Authentication

**Telegram:** `TELEGRAM_ALLOWED_USERS` environment variable — comma-separated list of user IDs. Messages from unlisted users are ignored.

**Slack:** `SLACK_ALLOWED_USERS` environment variable — comma-separated usernames or IDs. Messages from unlisted users are ignored.

**Webhooks:** `WEBHOOK_SECRET` environment variable. Requests must include a `Bearer` token matching the secret. Comparison uses `crypto.timingSafeEqual()` to prevent timing attacks. If `WEBHOOK_SECRET` is not set, the webhook endpoint returns 403 (disabled by default).

**OAuth:** Gmail OAuth flow uses a CSRF `state` parameter validated via `validateOAuthState()` on callback.

**Dashboard/Health server:** Bound to `127.0.0.1` only — not accessible from the network. No authentication layer required because the listener never binds to `0.0.0.0`.

### h. Credential Protection

- OAuth tokens are redacted in HTTP responses shown to the operator (first 4 and last 4 characters only).
- The health server renders the refresh token as `${first4}...${last4}` in the browser, with the full token logged only to the server console.
- `.env` files are excluded from file operation tools.
- API keys are loaded from environment variables, never hardcoded or logged.

## OWASP Top 10 for Agentic Applications (2026) Mapping

Mapped against the [OWASP Top 10 for Agentic Applications](https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/).

| # | OWASP Risk | Status | Implementation |
|---|-----------|--------|----------------|
| AA01 | Agentic Goal Hijacking / Prompt Injection | Mitigated | Content boundaries on all external data, injection pattern detection, heightened security mode, operator alerting |
| AA02 | Tool/Function Misuse | Mitigated | 4-layer Bash permissions, blocked command patterns, human-in-the-loop approval for dangerous operations, pre-approved allowlist for safe tools |
| AA03 | Privilege Escalation / Excessive Agency | Mitigated | Docker `--cap-drop ALL` + `--no-new-privileges`, vault write restrictions, workspace sandboxing, Claude Code path allowlist |
| AA04 | Insecure Tool / Agent Communication | Partial | Webhook auth with timing-safe comparison, localhost-only dashboard. No mTLS between agent and sub-agent (same-host process). |
| AA05 | Data Exfiltration via Agent | Mitigated | SSRF protection blocks internal network access, Docker `--network none`, blocked network tools (curl, wget, socat, nmap), credential redaction |
| AA06 | Rogue Agent / Cascading Failures | Mitigated | Single sub-agent (Claude Code) with concurrency guard, abort capability, max turn limit (50), operator-visible status |
| AA07 | Improper Access Control | Mitigated | Telegram/Slack user allowlists, webhook bearer token, OAuth CSRF state, localhost-only binding |
| AA08 | Insufficient Logging / Observability | Partial | Console logging of security events, injection detection alerts to operator, dashboard with session/task/log views. No centralized audit log or SIEM integration. |
| AA09 | Inadequate Sandboxing | Mitigated | Two-tier sandbox (lightweight allow-list + Docker with full isolation), path validation with symlink detection, shell metacharacter rejection |
| AA10 | Unsafe Output Handling | Mitigated | Content boundary markers prevent LLM from treating external data as instructions, output truncation (500 chars for Claude Code results, 10KB for sandbox), HTML-escaped OAuth tokens |

## Single-User Security Rationale

Aouda is deliberately single-user. This is a security decision, not a limitation.

**Multi-tenant AI agents are an unsolved problem.** When an agent has access to files, email, and command execution, isolating one user's context from another requires solving prompt injection perfectly — which no one has done. A shared-context agent serving multiple users turns every prompt injection vulnerability into a cross-tenant data breach.

**Shared context is a feature for single-user, a vulnerability for multi-user.** The agent knowing your email history, file structure, calendar, and preferences makes it useful. That same knowledge accessible to another user's prompt injections makes it dangerous.

**Less auth complexity means a smaller attack surface.** No user management, no role-based access control, no session isolation, no token management across users. The operator is authenticated once via Telegram/Slack allowlist, and that is the entire auth model.

If you need multi-user access, run separate instances.

## Known Limitations

These are real constraints. Treat them accordingly.

1. **Content boundaries are probabilistic.** They rely on the LLM respecting boundary markers. A sufficiently novel prompt injection could bypass them. Content boundaries raise the bar significantly but are not a guarantee.

2. **Injection detection uses pattern matching.** The ten patterns in `detectInjectionPatterns()` cover common injection idioms. Novel phrasings, non-English injections, or encoded attacks may evade detection.

3. **No end-to-end encryption for Telegram/Slack messages.** Messages between the agent and the operator traverse Telegram/Slack infrastructure. Sensitive data in agent responses is visible to those platforms.

4. **Docker sandbox requires Docker.** If Docker is not installed, untrusted commands that fall outside the lightweight allow-list are rejected rather than sandboxed. The agent degrades to lightweight-only mode without warning beyond the error response.

5. **Browser tools can access any allowed domain.** Without a configured domain allowlist, the browser can navigate to any public website. Operators running in sensitive environments should configure `BROWSER_ALLOWED_DOMAINS`.

6. **OAuth token is logged to console.** During the Gmail OAuth setup flow, the full refresh token is printed to the server console. This is a one-time setup convenience that trades security for usability. The token should be copied to `.env` and the log cleared.

7. **No rate limiting on dashboard API.** The dashboard is localhost-only, which limits exposure, but a local process could still abuse the API endpoints.

8. **Lightweight sandbox uses `/bin/sh -c`.** While shell metacharacters are rejected and the command allow-list is checked, the execution still goes through a shell. This is defense-in-depth, not a hard isolation boundary.

## Responsible Disclosure

If you discover a security vulnerability in Aouda:

- **Report via GitHub Security Advisories:** [github.com/thatrebeccarae/aouda/security/advisories](https://github.com/thatrebeccarae/aouda/security/advisories)
- **Response time:** 48 hours for acknowledgment, 7 days for a fix plan
- **Scope:** Vulnerabilities in the agent's security controls (sandbox escape, content boundary bypass, SSRF bypass, auth bypass, path traversal). Not in scope: vulnerabilities in upstream dependencies (report those to the dependency maintainer), or LLM behavioral issues (report those to the model provider).
- **No bug bounty.** This is an individual open-source project.
- **Credit:** Reporters will be credited in the CHANGELOG unless they request otherwise.

Please do not open a public GitHub issue for security vulnerabilities. Use GitHub Security Advisories instead.
