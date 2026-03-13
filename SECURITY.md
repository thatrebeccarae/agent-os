# Security Policy

## Supported Versions

| Version | Supported          |
|---------|--------------------|
| 1.x     | :white_check_mark: |
| < 1.0   | :x:                |

## Reporting a Vulnerability

**Do not open a public issue for security vulnerabilities.**

Please report security issues by emailing **security@aouda.dev** (or by opening a private security advisory on GitHub). Include:

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

You will receive an acknowledgment within 48 hours. We follow a 90-day coordinated disclosure policy — we will work with you to understand and address the issue before any public disclosure.

## Security Architecture

Aouda is designed with a defense-in-depth security model:

### Content Boundary Wrapping

All external content (email, web search, RSS feeds, browser output, calendar data, webhook payloads) is wrapped with randomized boundary markers before entering the LLM context. This prevents prompt injection from external sources.

- 10 known injection patterns detected and flagged
- Unicode homoglyph normalization prevents marker spoofing
- External content tagged during memory extraction

### Three-Layer Command Approval

Shell command execution uses a three-tier approval system:

1. **Auto-deny**: Dangerous patterns (rm -rf, force push, curl piping to shell, network scanning) are blocked unconditionally
2. **Auto-approve**: Read-only commands (ls, cat, git log, grep) execute without approval
3. **Interactive approval**: Everything else requires explicit operator approval via messaging channel (30-minute timeout, auto-deny)

### SSRF Protection

All outbound HTTP requests are validated:

- Internal/private IP ranges blocked (10.x, 172.16-31.x, 192.168.x, 127.x, ::1)
- Dangerous protocols blocked (file://, gopher://, dict://)
- Decimal and octal IP obfuscation detected and blocked

### Sandbox Isolation

- Docker-based sandbox with `--network none`, `--cap-drop ALL`, and read-only mounts
- File system access restricted to designated safe directories
- Agent workspace isolated from host system

### Dashboard & API Security

- Bearer token authentication with timing-safe comparison
- Rate limiting (webhook: 10 req/min, dashboard: 60 req/min per IP)
- Secret scrubbing in log output
- Express server bound to localhost only

## Threat Model

Aouda assumes a single trusted operator. The security model protects against:

- **Prompt injection** from external content (email, web pages, RSS)
- **Unauthorized command execution** via the agent
- **Data exfiltration** through SSRF or unrestricted network access
- **Credential exposure** in logs or dashboard output

The following are **out of scope** (operator-intended behavior):

- Operator-configured tool access
- Operator-installed plugins executing with agent privileges
- Actions taken with explicit operator approval

## Disclosure Policy

We follow a 90-day coordinated disclosure timeline:

1. **Day 0**: Vulnerability reported
2. **Day 2**: Acknowledgment sent
3. **Day 7**: Initial assessment shared with reporter
4. **Day 90**: Public disclosure (with or without fix, coordinated with reporter)

Critical vulnerabilities (RCE, credential exposure) will be patched and disclosed on an accelerated timeline.
