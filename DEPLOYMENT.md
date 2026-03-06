# Deploying Aouda

## Prerequisites

- **Node.js >= 22** and **pnpm**
- A **Telegram bot** token (see [Integration Setup: Telegram](#telegram) below)
- At least one **LLM provider API key** (Anthropic, OpenAI, or Gemini)
- Optional: Docker (for sandboxed command execution), Gmail OAuth credentials, Slack app, Miniflux, n8n, Playwright

Copy and configure the environment file:

```bash
cp .env.example .env
# Edit .env with your tokens and API keys
```

Build the project:

```bash
pnpm install
pnpm build
```

---

## macOS (launchd)

This is the primary deployment target. The repository includes install and uninstall scripts.

### Install

```bash
# Edit config/com.aouda.agent.plist to set the correct paths for your system
bash scripts/install-service.sh
```

The install script copies the plist to `~/Library/LaunchAgents/` and loads it via `launchctl`.

### Logs

Logs are written to `/tmp/aouda.log` by default (configured in the plist). Tail them with:

```bash
tail -f /tmp/aouda.log
```

### Manage the service

```bash
# Check status
launchctl list | grep com.aouda.agent

# Stop
launchctl unload ~/Library/LaunchAgents/com.aouda.agent.plist

# Start
launchctl load ~/Library/LaunchAgents/com.aouda.agent.plist

# Restart (kickstart)
launchctl kickstart -k gui/$(id -u)/com.aouda.agent
```

The plist uses `KeepAlive` so macOS will automatically restart the agent if it crashes.

### Uninstall

```bash
bash scripts/uninstall-service.sh
```

---

## Linux (systemd)

Create a systemd unit file at `/etc/systemd/system/aouda.service`:

```ini
[Unit]
Description=Aouda
After=network.target

[Service]
Type=simple
User=<your-user>
WorkingDirectory=/path/to/aouda
ExecStart=/usr/bin/npx tsx src/index.ts
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

If you have built the project, use the compiled output instead:

```ini
ExecStart=/usr/bin/node dist/index.js
```

The `.env` file must be in the `WorkingDirectory`. Alternatively, use `EnvironmentFile=/path/to/aouda/.env` in the unit file.

### Manage the service

```bash
sudo systemctl daemon-reload
sudo systemctl enable aouda
sudo systemctl start aouda

# Check status
systemctl status aouda

# View logs
journalctl -u aouda -f

# Restart
sudo systemctl restart aouda
```

---

## Docker

### Dockerfile

```dockerfile
FROM node:22-slim
RUN npm i -g pnpm
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod
COPY . .
RUN pnpm build
CMD ["node", "dist/index.js"]
```

### Build and run

```bash
docker build -t aouda .
docker run -d --name aouda --env-file .env --restart unless-stopped aouda
```

### docker-compose

```yaml
version: "3.8"
services:
  aouda:
    build: .
    env_file: .env
    restart: unless-stopped
    ports:
      - "3210:3210"
    volumes:
      - ./data:/app/data
```

```bash
docker compose up -d
```

### Note on Docker sandbox

If you use the `run_command` tool with Docker-tier sandboxing, the agent needs access to the Docker socket. This means Docker-in-Docker or mounting the host socket:

```yaml
volumes:
  - /var/run/docker.sock:/var/run/docker.sock:ro
```

Be aware of the security implications of exposing the Docker socket.

---

## Integration Setup Guides

Each integration is optional. Configure only what you need.

### Telegram

1. Message [@BotFather](https://t.me/BotFather) on Telegram.
2. Send `/newbot`, follow the prompts, and copy the bot token.
3. Set `TELEGRAM_BOT_TOKEN` in `.env`.
4. To find your chat ID: send a message to your bot, then visit `https://api.telegram.org/bot<TOKEN>/getUpdates` and look for `chat.id`.
5. Set `TELEGRAM_OWNER_CHAT_ID` to enable proactive notifications (inbox monitoring, Docker alerts).
6. Optionally set `TELEGRAM_ALLOWED_USERS` to restrict access to specific user IDs (comma-separated).

### Gmail

1. Go to the [Google Cloud Console](https://console.cloud.google.com/).
2. Create a project (or use an existing one).
3. Enable the **Gmail API**.
4. Create an **OAuth 2.0 Client ID** (type: Web application).
5. Add redirect URI: `http://localhost:3210/oauth/gmail/callback`.
6. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in `.env`.
7. Start the agent, then visit `http://localhost:3210/oauth/gmail/start` in a browser.
8. Complete the OAuth flow. Copy the refresh token.
9. Set `GMAIL_REFRESH_TOKEN` in `.env` and restart.

### Google Calendar

Uses the same GCP project and OAuth credentials as Gmail.

1. Enable the **Google Calendar API** in your GCP project.
2. The same `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and OAuth flow apply.
3. Calendar tools become available automatically when Google credentials are configured.

### Slack

1. Create a Slack app at [api.slack.com/apps](https://api.slack.com/apps).
2. Enable **Socket Mode** (Settings > Socket Mode).
3. Add bot token scopes: `chat:write`, `channels:history`, `channels:read`, `users:read`.
4. Install the app to your workspace.
5. Set these in `.env`:
   - `SLACK_BOT_TOKEN` (starts with `xoxb-`)
   - `SLACK_APP_TOKEN` (starts with `xapp-`, from Socket Mode settings)
6. Optionally set `SLACK_ALLOWED_USERS` to restrict access.

### Miniflux (RSS)

1. Self-host [Miniflux](https://miniflux.app/) or use an existing instance.
2. Go to Miniflux Settings > API Keys and create a key.
3. Set in `.env`:
   - `MINIFLUX_API_KEY`
   - `MINIFLUX_URL` (defaults to `http://localhost:8080`)

### n8n (Workflow Automation)

1. Self-host [n8n](https://n8n.io/) or use an existing instance.
2. Go to n8n Settings > API and create an API key.
3. Set in `.env`:
   - `N8N_API_KEY`
   - `N8N_URL` (defaults to `http://localhost:5678`)

### Browser Automation

Browser tools use Playwright with Chromium. It is an optional dependency:

```bash
pnpm install playwright-chromium
```

No additional environment variables are needed. Browser tools become available when Playwright is installed.

### Claude Code (Handoff)

The `handoff_to_claude_code` tool delegates development tasks to a local Claude Code agent via the `@anthropic-ai/claude-agent-sdk`.

- It uses the same `ANTHROPIC_API_KEY` already set for the Anthropic LLM provider.
- No additional keys are needed.
- Approval requests (e.g., for Bash commands) route to the operator via Telegram, so `TELEGRAM_OWNER_CHAT_ID` must be set.

---

## Personality Configuration

The agent's personality is defined in a "soul file" -- a Markdown document that sets its name, voice, values, and behavioral boundaries.

Copy the example and customize it:

```bash
cp config/soul.example.md config/soul.md
# Edit config/soul.md to define your agent's personality
```

The soul file is loaded at startup and used as the system prompt foundation.

---

## Monitoring

### Dashboard

The agent exposes a web dashboard at:

```
http://localhost:3210
```

The port defaults to `3210` and can be changed with the `PORT` environment variable. If `DASHBOARD_TOKEN` is set, requests must include it as a Bearer token or query parameter.

### Health Check

The dashboard endpoint also serves as a health check. A `200` response on `/` means the agent is running.

### Logs

- **macOS (launchd):** `/tmp/aouda.log` (or as configured in the plist)
- **Linux (systemd):** `journalctl -u aouda -f`
- **Docker:** `docker logs -f aouda`

---

## Updating

### macOS (launchd)

```bash
cd /path/to/aouda
git pull
pnpm install
pnpm build
launchctl kickstart -k gui/$(id -u)/com.aouda.agent
```

### Linux (systemd)

```bash
cd /path/to/aouda
git pull
pnpm install
pnpm build
sudo systemctl restart aouda
```

### Docker

```bash
cd /path/to/aouda
git pull
docker compose build
docker compose up -d
```
