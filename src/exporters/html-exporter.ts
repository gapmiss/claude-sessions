import { App, TFolder, normalizePath } from 'obsidian';
import { Session, PluginSettings } from '../types';

export async function exportToHtml(
	app: App,
	session: Session,
	settings: PluginSettings
): Promise<void> {
	const html = buildHtml(session, settings);
	const folder = normalizePath(settings.exportFolder);

	const existing = app.vault.getAbstractFileByPath(folder);
	if (!existing) {
		await app.vault.createFolder(folder);
	} else if (!(existing instanceof TFolder)) {
		throw new Error(`${folder} exists but is not a folder.`);
	}

	const safeName = session.metadata.id
		.replace(/[^a-zA-Z0-9_-]/g, '_')
		.substring(0, 80);
	const fileName = normalizePath(`${folder}/${safeName}.html`);

	// Write via adapter since Obsidian doesn't natively create .html
	await app.vault.adapter.write(fileName, html);
}

function buildHtml(session: Session, settings: PluginSettings): string {
	// Base64 encode session data for embedding
	const sessionJson = JSON.stringify({
		metadata: session.metadata,
		turns: session.turns,
		settings: {
			showThinkingBlocks: settings.showThinkingBlocks,
			showToolCalls: settings.showToolCalls,
			showToolResults: settings.showToolResults,
		},
	});
	const encoded = btoa(unescape(encodeURIComponent(sessionJson)));

	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Session: ${escapeHtml(session.metadata.project)}</title>
<style>
:root {
  --bg: #1e1e2e;
  --bg-secondary: #313244;
  --text: #cdd6f4;
  --text-muted: #a6adc8;
  --accent: #89b4fa;
  --accent-hover: #74c7ec;
  --border: #45475a;
  --user-bg: #89b4fa;
  --user-text: #1e1e2e;
  --assistant-bg: #a6e3a1;
  --assistant-text: #1e1e2e;
  --error: #f38ba8;
  --success: #a6e3a1;
  --radius: 8px;
}
@media (prefers-color-scheme: light) {
  :root {
    --bg: #eff1f5;
    --bg-secondary: #e6e9ef;
    --text: #4c4f69;
    --text-muted: #6c6f85;
    --accent: #1e66f5;
    --accent-hover: #04a5e5;
    --border: #ccd0da;
    --user-bg: #1e66f5;
    --user-text: #eff1f5;
    --assistant-bg: #40a02b;
    --assistant-text: #eff1f5;
    --error: #d20f39;
    --success: #40a02b;
  }
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: var(--bg); color: var(--text); line-height: 1.6; }
.controls { position: sticky; top: 0; z-index: 10; display: flex; align-items: center; gap: 8px; padding: 12px 16px; background: var(--bg-secondary); border-bottom: 1px solid var(--border); flex-wrap: wrap; }
.controls button { min-width: 44px; min-height: 44px; padding: 6px 12px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--bg); color: var(--text); cursor: pointer; font-size: 14px; }
.controls button:hover { background: var(--accent); color: var(--user-text); }
.controls button.active { background: var(--accent); color: var(--user-text); }
.controls button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
input[type=range] { flex: 1; min-width: 100px; accent-color: var(--accent); }
.status { font-size: 13px; color: var(--text-muted); min-width: 100px; text-align: center; }
.content { max-width: 900px; margin: 0 auto; padding: 24px 16px; }
.turn { margin-bottom: 24px; }
.turn-header { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; padding-bottom: 4px; border-bottom: 1px solid var(--border); }
.role { font-weight: 600; padding: 2px 10px; border-radius: var(--radius); font-size: 13px; }
.role-user { background: var(--user-bg); color: var(--user-text); }
.role-assistant { background: var(--assistant-bg); color: var(--assistant-text); }
.timestamp { font-size: 12px; color: var(--text-muted); }
.text-block { margin-bottom: 8px; white-space: pre-wrap; }
details { margin: 8px 0; border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
summary { padding: 8px 12px; cursor: pointer; background: var(--bg-secondary); font-size: 13px; color: var(--text-muted); min-height: 44px; display: flex; align-items: center; }
summary:hover { background: var(--border); }
summary:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.block-content { padding: 8px 12px; max-height: 400px; overflow-y: auto; }
pre { background: var(--bg-secondary); padding: 12px; border-radius: var(--radius); overflow-x: auto; font-size: 13px; line-height: 1.5; }
code { font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace; }
.error summary { color: var(--error); }
.meta { padding: 16px; margin-bottom: 16px; background: var(--bg-secondary); border-radius: var(--radius); font-size: 13px; }
.meta span { display: inline-block; margin-right: 16px; }
.meta strong { color: var(--accent); }
</style>
</head>
<body>
<div class="controls" id="controls">
  <button onclick="prevTurn()" aria-label="Previous turn">\u25C0</button>
  <button onclick="togglePlay()" id="playBtn" aria-label="Play/pause">\u25B6</button>
  <button onclick="nextTurn()" aria-label="Next turn">\u25B6</button>
  <input type="range" id="progress" min="0" value="0" oninput="goToTurn(+this.value)" aria-label="Turn progress">
  <span class="status" id="status">Loading...</span>
  <button onclick="setSpeed(0.5)">0.5x</button>
  <button onclick="setSpeed(1)" class="active" id="speed1">1x</button>
  <button onclick="setSpeed(2)">2x</button>
  <button onclick="setSpeed(5)">5x</button>
</div>
<div class="content" id="content"></div>
<script id="session-data" type="application/json">${encoded}</script>
<script>
(function() {
  var raw = document.getElementById('session-data').textContent;
  var data;
  try { data = JSON.parse(decodeURIComponent(escape(atob(raw)))); }
  catch(e) { document.getElementById('content').textContent = 'Failed to load session data.'; return; }
  var turns = data.turns;
  var meta = data.metadata;
  var settings = data.settings;
  var current = 0;
  var playing = false;
  var timer = null;
  var speed = 1;
  var progress = document.getElementById('progress');
  var status = document.getElementById('status');
  var content = document.getElementById('content');
  var playBtn = document.getElementById('playBtn');

  progress.max = Math.max(0, turns.length - 1);

  // Render metadata
  var metaDiv = document.createElement('div');
  metaDiv.className = 'meta';
  metaDiv.innerHTML = '<span><strong>Project:</strong> ' + esc(meta.project) + '</span>' +
    (meta.model ? '<span><strong>Model:</strong> ' + esc(meta.model) + '</span>' : '') +
    (meta.branch ? '<span><strong>Branch:</strong> ' + esc(meta.branch) + '</span>' : '') +
    '<span><strong>Turns:</strong> ' + turns.length + '</span>' +
    (meta.startTime ? '<span><strong>Date:</strong> ' + esc(new Date(meta.startTime).toLocaleString()) + '</span>' : '');
  content.appendChild(metaDiv);

  var turnContainer = document.createElement('div');
  turnContainer.id = 'turn-container';
  content.appendChild(turnContainer);

  function render() {
    turnContainer.innerHTML = '';
    if (turns.length === 0) { turnContainer.innerHTML = '<p>No turns in session.</p>'; return; }
    var turn = turns[current];
    var div = document.createElement('div');
    div.className = 'turn';
    var header = '<div class="turn-header"><span class="role role-' + turn.role + '">' + (turn.role === 'user' ? 'User' : 'Assistant') + '</span>';
    if (turn.timestamp) header += '<span class="timestamp">' + esc(new Date(turn.timestamp).toLocaleString()) + '</span>';
    header += '</div>';
    div.innerHTML = header;
    for (var i = 0; i < turn.contentBlocks.length; i++) {
      var block = turn.contentBlocks[i];
      var el = renderBlock(block);
      if (el) div.appendChild(el);
    }
    turnContainer.appendChild(div);
    progress.value = current;
    status.textContent = 'Turn ' + (current + 1) + ' / ' + turns.length + ' \\u00B7 ' + speed + 'x';
  }

  function renderBlock(b) {
    if (b.type === 'text') {
      var d = document.createElement('div');
      d.className = 'text-block';
      d.textContent = b.text;
      return d;
    }
    if (b.type === 'thinking' && settings.showThinkingBlocks) {
      return makeDetails('\\uD83D\\uDCAD Thinking', b.thinking);
    }
    if (b.type === 'tool_use' && settings.showToolCalls) {
      return makeDetails('\\uD83D\\uDD27 ' + b.name, JSON.stringify(b.input, null, 2));
    }
    if (b.type === 'tool_result' && settings.showToolResults) {
      var label = b.toolName ? 'Result: ' + b.toolName : 'Tool result';
      var icon = b.isError ? '\\u274C' : '\\u2705';
      var d = makeDetails(icon + ' ' + label, b.content.length > 5000 ? b.content.substring(0, 5000) + '\\n... (truncated)' : b.content);
      if (b.isError) d.className += ' error';
      return d;
    }
    return null;
  }

  function makeDetails(summaryText, bodyText) {
    var d = document.createElement('details');
    var s = document.createElement('summary');
    s.textContent = summaryText;
    d.appendChild(s);
    var c = document.createElement('div');
    c.className = 'block-content';
    var pre = document.createElement('pre');
    var code = document.createElement('code');
    code.textContent = bodyText;
    pre.appendChild(code);
    c.appendChild(pre);
    d.appendChild(c);
    return d;
  }

  function esc(s) { var d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

  window.goToTurn = function(idx) { current = Math.max(0, Math.min(idx, turns.length - 1)); render(); };
  window.nextTurn = function() { window.goToTurn(current + 1); };
  window.prevTurn = function() { window.goToTurn(current - 1); };
  window.togglePlay = function() {
    playing = !playing;
    playBtn.textContent = playing ? '\\u23F8' : '\\u25B6';
    if (playing) { timer = setInterval(function() { if (current >= turns.length - 1) { window.togglePlay(); return; } window.nextTurn(); }, 2000 / speed); }
    else { clearInterval(timer); timer = null; }
  };
  window.setSpeed = function(s) {
    speed = s;
    document.querySelectorAll('.controls button').forEach(function(b) { b.classList.remove('active'); });
    if (playing) { clearInterval(timer); timer = setInterval(function() { if (current >= turns.length - 1) { window.togglePlay(); return; } window.nextTurn(); }, 2000 / speed); }
    render();
  };

  document.addEventListener('keydown', function(e) {
    if (e.key === 'ArrowLeft') { e.preventDefault(); window.prevTurn(); }
    if (e.key === 'ArrowRight') { e.preventDefault(); window.nextTurn(); }
    if (e.key === ' ') { e.preventDefault(); window.togglePlay(); }
    if (e.key === '[') { e.preventDefault(); window.setSpeed(Math.max(0.5, speed - 0.5)); }
    if (e.key === ']') { e.preventDefault(); window.setSpeed(Math.min(5, speed + 0.5)); }
  });

  render();
})();
</script>
</body>
</html>`;
}

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}
