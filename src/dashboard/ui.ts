/**
 * Inline HTML dashboard for Agent agent.
 * Single self-contained file — no build step, no external deps.
 * Served at GET / by the Express health server.
 */

import { AGENT_NAME } from '../config/identity.js';

export function getDashboardHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${AGENT_NAME} Dashboard</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg: #0d1117;
    --surface: #161b22;
    --border: #30363d;
    --text: #c9d1d9;
    --text-dim: #8b949e;
    --accent: #58a6ff;
    --green: #3fb950;
    --yellow: #d29922;
    --red: #f85149;
    --font: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
  }
  body { background: var(--bg); color: var(--text); font-family: var(--font); font-size: 13px; padding: 16px; }
  h1 { font-size: 18px; font-weight: 600; }
  h2 { font-size: 14px; font-weight: 600; color: var(--accent); margin-bottom: 8px; text-transform: uppercase; letter-spacing: 1px; }

  .header { display: flex; align-items: center; gap: 12px; margin-bottom: 20px; padding-bottom: 12px; border-bottom: 1px solid var(--border); }
  .status-dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
  .status-dot.green { background: var(--green); box-shadow: 0 0 6px var(--green); }
  .status-dot.yellow { background: var(--yellow); box-shadow: 0 0 6px var(--yellow); }
  .status-dot.red { background: var(--red); box-shadow: 0 0 6px var(--red); }
  .uptime { color: var(--text-dim); font-size: 12px; }
  .version { color: var(--text-dim); font-size: 11px; margin-left: auto; }

  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  @media (max-width: 900px) { .grid { grid-template-columns: 1fr; } }

  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 14px; }
  .card.full { grid-column: 1 / -1; }

  .log-list { max-height: 260px; overflow-y: auto; font-size: 11px; line-height: 1.6; }
  .log-list .entry { padding: 1px 0; white-space: pre-wrap; word-break: break-all; }
  .log-list .entry.error { color: var(--red); }
  .log-list .entry.warn { color: var(--yellow); }
  .log-list .ts { color: var(--text-dim); margin-right: 6px; }

  .task-list { max-height: 200px; overflow-y: auto; }
  .task-item { display: flex; gap: 8px; align-items: center; padding: 4px 0; border-bottom: 1px solid var(--border); font-size: 12px; }
  .task-item:last-child { border-bottom: none; }
  .badge { padding: 2px 6px; border-radius: 4px; font-size: 10px; font-weight: 600; text-transform: uppercase; }
  .badge.pending { background: #1f2937; color: var(--text-dim); }
  .badge.running { background: #1c2d1c; color: var(--green); }
  .badge.completed { background: #0d2230; color: var(--accent); }
  .badge.failed { background: #2d1c1c; color: var(--red); }
  .badge.cancelled { background: #1f2937; color: var(--text-dim); }

  .fact-list { max-height: 180px; overflow-y: auto; }
  .fact-item { padding: 4px 0; border-bottom: 1px solid var(--border); font-size: 12px; line-height: 1.4; }
  .fact-item:last-child { border-bottom: none; }
  .fact-time { color: var(--text-dim); font-size: 10px; }

  .provider-grid { display: flex; gap: 10px; flex-wrap: wrap; }
  .provider { padding: 6px 10px; border-radius: 6px; font-size: 12px; display: flex; align-items: center; gap: 6px; background: #1f2937; }

  .session-list { max-height: 180px; overflow-y: auto; }
  .session-item { display: flex; justify-content: space-between; padding: 4px 0; border-bottom: 1px solid var(--border); font-size: 12px; }
  .session-item:last-child { border-bottom: none; }

  .cc-info { font-size: 12px; }
  .cc-idle { color: var(--text-dim); }
  .cc-active { color: var(--green); }

  .monitor-row { display: flex; justify-content: space-between; padding: 4px 0; font-size: 12px; }

  .stat { text-align: center; }
  .stat-value { font-size: 22px; font-weight: 700; color: var(--accent); }
  .stat-label { font-size: 10px; color: var(--text-dim); text-transform: uppercase; }
  .stats-row { display: flex; gap: 20px; margin-bottom: 12px; }
</style>
</head>
<body>

<div class="header">
  <span class="status-dot green" id="statusDot"></span>
  <h1>${AGENT_NAME}</h1>
  <span class="uptime" id="uptime">--</span>
  <span class="version" id="version">v--</span>
</div>

<div class="stats-row">
  <div class="stat"><div class="stat-value" id="sessionCount">-</div><div class="stat-label">Sessions</div></div>
  <div class="stat"><div class="stat-value" id="messageCount">-</div><div class="stat-label">Messages</div></div>
  <div class="stat"><div class="stat-value" id="pendingTasks">-</div><div class="stat-label">Pending</div></div>
</div>

<div class="grid">

  <div class="card full">
    <h2>Activity Log</h2>
    <div class="log-list" id="logList"></div>
  </div>

  <div class="card">
    <h2>Task Queue</h2>
    <div class="task-list" id="taskList"></div>
  </div>

  <div class="card">
    <h2>Claude Code</h2>
    <div class="cc-info" id="ccInfo">
      <span class="cc-idle">Idle</span>
    </div>
    <h2 style="margin-top:14px">Monitors</h2>
    <div id="monitors"></div>
  </div>

  <div class="card">
    <h2>Memory (Recent Facts)</h2>
    <div class="fact-list" id="factList"></div>
  </div>

  <div class="card">
    <h2>LLM Providers</h2>
    <div class="provider-grid" id="providers"></div>
    <h2 style="margin-top:14px">Sessions</h2>
    <div class="session-list" id="sessionList"></div>
  </div>

</div>

<script>
const POLL_MS = 5000;

function fmt(ts) {
  if (!ts) return '--';
  const d = new Date(typeof ts === 'number' ? ts : ts);
  return d.toLocaleTimeString('en-US', { hour12: false });
}

function fmtUptime(s) {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return d + 'd ' + h + 'h ' + m + 'm';
  if (h > 0) return h + 'h ' + m + 'm';
  return m + 'm ' + (s % 60) + 's';
}

function esc(s) {
  const el = document.createElement('span');
  el.textContent = s;
  return el.innerHTML;
}

async function fetchJSON(url) {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

async function poll() {
  const [status, version, tasks, logs, memory, sessions] = await Promise.all([
    fetchJSON('/api/status'),
    fetchJSON('/version'),
    fetchJSON('/api/tasks'),
    fetchJSON('/api/logs?limit=80'),
    fetchJSON('/api/memory?limit=10'),
    fetchJSON('/api/sessions'),
  ]);

  // Status + header
  if (status) {
    document.getElementById('uptime').textContent = fmtUptime(status.uptime);
    document.getElementById('sessionCount').textContent = status.sessions;
    document.getElementById('messageCount').textContent = status.messages;
    document.getElementById('pendingTasks').textContent = status.tasks.pending;

    // Providers
    const pEl = document.getElementById('providers');
    pEl.innerHTML = Object.entries(status.providers).map(function(e) {
      var k = e[0], v = e[1];
      var dot = v ? 'green' : 'red';
      return '<div class="provider"><span class="status-dot ' + dot + '"></span>' + esc(k) + '</div>';
    }).join('');

    // Claude Code
    var ccEl = document.getElementById('ccInfo');
    if (status.claudeCode.active) {
      var dur = Math.floor(status.claudeCode.durationMs / 1000);
      ccEl.innerHTML = '<span class="cc-active">Active: ' + esc(status.claudeCode.title) + '</span><br><span style="color:var(--text-dim)">Duration: ' + fmtUptime(dur) + '</span>';
    } else {
      ccEl.innerHTML = '<span class="cc-idle">Idle</span>';
    }

    // Monitors
    var mEl = document.getElementById('monitors');
    var hbLabel = status.heartbeat.status === 'active'
      ? (status.heartbeat.lastPulse ? 'active (' + (status.heartbeat.lastAction || 'pending') + ')' : 'active (pending)')
      : 'disabled';
    mEl.innerHTML = '<div class="monitor-row"><span>Inbox</span><span>' + esc(status.monitors.inbox) + '</span></div>' +
      '<div class="monitor-row"><span>Docker</span><span>' + esc(status.monitors.docker) + '</span></div>' +
      '<div class="monitor-row"><span>Calendar</span><span>' + esc(status.monitors.calendar) + '</span></div>' +
      '<div class="monitor-row"><span>Heartbeat</span><span>' + esc(hbLabel) + '</span></div>';

    // Status dot
    var dot = document.getElementById('statusDot');
    dot.className = 'status-dot green';
  } else {
    document.getElementById('statusDot').className = 'status-dot red';
  }

  if (version) {
    document.getElementById('version').textContent = 'v' + version.version;
  }

  // Logs
  if (logs && logs.logs) {
    var el = document.getElementById('logList');
    var wasAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
    el.innerHTML = logs.logs.map(function(l) {
      var cls = l.level === 'error' ? ' error' : l.level === 'warn' ? ' warn' : '';
      return '<div class="entry' + cls + '"><span class="ts">' + fmt(l.timestamp) + '</span>' + esc(l.message) + '</div>';
    }).join('');
    if (wasAtBottom) el.scrollTop = el.scrollHeight;
  }

  // Tasks
  if (tasks && tasks.tasks) {
    document.getElementById('taskList').innerHTML = tasks.tasks.slice(0, 15).map(function(t) {
      return '<div class="task-item"><span class="badge ' + t.status + '">' + t.status + '</span><span>' + esc(t.title) + '</span></div>';
    }).join('') || '<div style="color:var(--text-dim)">No tasks</div>';
  }

  // Memory
  if (memory && memory.facts) {
    document.getElementById('factList').innerHTML = memory.facts.map(function(f) {
      return '<div class="fact-item"><div>' + esc(f.fact) + '</div><div class="fact-time">' + fmt(f.createdAt) + '</div></div>';
    }).join('') || '<div style="color:var(--text-dim)">No facts</div>';
  }

  // Sessions
  if (sessions && sessions.sessions) {
    document.getElementById('sessionList').innerHTML = sessions.sessions.slice(0, 10).map(function(s) {
      return '<div class="session-item"><span>' + esc(s.id) + '</span><span>' + s.message_count + ' msgs</span></div>';
    }).join('') || '<div style="color:var(--text-dim)">No sessions</div>';
  }
}

poll();
setInterval(poll, POLL_MS);
</script>
</body>
</html>`;
}
