const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const chokidar = require('chokidar');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// State
const state = {
  sessions: new Map(), // sessionId -> { files: Set, terminals: Set, active: boolean, thinking: boolean, lastActivity: number, machine: string, tokens: {} }
  files: new Map(),    // filePath -> { sessions: Set, lastInteraction: null }
  folders: new Map(),  // folderPath -> { sessions: Set, children: Set }
  terminals: new Map(), // terminalId -> { sessionId, command }
  machines: new Map()  // machineName -> { sessions: Set, color: string, lastSeen: number }
};

// Global token stats
let globalTokens = {
  totalInput: 0,
  totalOutput: 0,
  totalCacheRead: 0,
  totalCacheCreation: 0
};

// Base path to make paths relative (use working directory or home)
const BASE_PATH = process.env.HOME || '/root';

// Get folder hierarchy from a file path (returns array of folder paths)
function getFolderHierarchy(filePath, basePath) {
  const base = basePath || BASE_PATH;

  // Make path relative to basePath
  let relativePath = filePath;
  if (filePath.startsWith(base)) {
    relativePath = filePath.slice(base.length);
  } else if (filePath.startsWith(BASE_PATH)) {
    relativePath = filePath.slice(BASE_PATH.length);
  }

  const parts = relativePath.split('/').filter(p => p);
  const folders = [];
  let currentPath = '';

  // Skip the filename (last part)
  for (let i = 0; i < parts.length - 1; i++) {
    currentPath += '/' + parts[i];
    folders.push({
      path: currentPath,
      name: parts[i],
      depth: i
    });
  }

  return folders;
}

// Machine colors for visual distinction
const MACHINE_COLORS = [
  '#ff69b4', // pink (default)
  '#4ade80', // green
  '#60a5fa', // blue
  '#f472b6', // light pink
  '#a78bfa', // purple
  '#fbbf24', // yellow
  '#34d399', // teal
  '#f87171', // red
];

// Specific machine color overrides
const MACHINE_COLOR_OVERRIDES = {
  'agentvps': '#fbbf24', // yellow
};

// Session activity timeout (mark inactive after 30 seconds of no activity)
const SESSION_INACTIVE_TIMEOUT = 30000;
// Session removal timeout (remove after 5 minutes of inactivity)
const SESSION_REMOVE_TIMEOUT = 300000;

// Broadcast to all clients
function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === 1) client.send(msg);
  });
}

// Parse Claude history for events
function parseHistoryLine(line) {
  try {
    const entry = JSON.parse(line);
    return entry;
  } catch {
    return null;
  }
}

// Set session thinking state
function setSessionThinking(sessionId, thinking) {
  if (state.sessions.has(sessionId)) {
    const session = state.sessions.get(sessionId);
    session.thinking = thinking;
    session.active = true;
    session.lastActivity = Date.now();
    // Clear waiting state when thinking
    if (thinking) session.waiting = false;
    broadcast({ type: 'session_thinking', sessionId, thinking });

    // Auto-stop thinking after 3 seconds
    if (thinking) {
      setTimeout(() => {
        if (state.sessions.has(sessionId)) {
          const s = state.sessions.get(sessionId);
          if (s.thinking) {
            s.thinking = false;
            broadcast({ type: 'session_thinking', sessionId, thinking: false });
          }
        }
      }, 3000);
    }
  }
}

// Set session waiting for permission state
function setSessionWaiting(sessionId, waiting, toolName) {
  if (state.sessions.has(sessionId)) {
    const session = state.sessions.get(sessionId);
    session.waiting = waiting;
    session.waitingTool = toolName || null;
    session.active = true;
    session.thinking = false; // Not thinking while waiting
    session.lastActivity = Date.now();
    broadcast({ type: 'session_waiting', sessionId, waiting, toolName });
  }
}

// Get or create machine entry
function getOrCreateMachine(machineName) {
  if (!state.machines.has(machineName)) {
    const color = MACHINE_COLOR_OVERRIDES[machineName] || MACHINE_COLORS[state.machines.size % MACHINE_COLORS.length];
    state.machines.set(machineName, {
      sessions: new Set(),
      color: color,
      lastSeen: Date.now()
    });
    broadcast({ type: 'machine_add', machineName, color: color });
  }
  const machine = state.machines.get(machineName);
  machine.lastSeen = Date.now();
  return machine;
}

// Process Claude event
function processEvent(event) {
  if (!event) return;

  const sessionId = event.sessionId || event.session_id || 'default';
  const machineName = event.machine_name || 'unknown';

  // Get or create machine
  const machine = getOrCreateMachine(machineName);

  // Ensure session exists
  if (!state.sessions.has(sessionId)) {
    state.sessions.set(sessionId, {
      files: new Set(),
      terminals: new Set(),
      active: true,
      thinking: false,
      waiting: false,
      waitingTool: null,
      lastActivity: Date.now(),
      machine: machineName,
      color: machine.color,
      cwd: event.cwd || BASE_PATH,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
      x: Math.random() * 600 + 100,
      y: Math.random() * 400 + 100
    });
    machine.sessions.add(sessionId);
    broadcast({
      type: 'session_add',
      sessionId,
      machine: machineName,
      color: machine.color,
      ...state.sessions.get(sessionId)
    });
  }

  // Process token data if provided (tokens from hook are CUMULATIVE totals for session)
  if (event.tokens && typeof event.tokens === 'object') {
    const session = state.sessions.get(sessionId);
    const t = event.tokens;

    // Store cumulative tokens directly from hook
    const newTokens = {
      input: t.input_tokens || 0,
      output: t.output_tokens || 0,
      cacheRead: t.cache_read || 0,
      cacheCreation: t.cache_creation || 0
    };

    // Calculate delta for animations and global tracking
    const prevTokens = session.lastSeenTokens || { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
    const delta = {
      input: Math.max(0, newTokens.input - prevTokens.input),
      output: Math.max(0, newTokens.output - prevTokens.output),
      cacheRead: Math.max(0, newTokens.cacheRead - prevTokens.cacheRead),
      cacheCreation: Math.max(0, newTokens.cacheCreation - prevTokens.cacheCreation)
    };

    // Update session with cumulative values (not delta)
    session.tokens = { ...newTokens };
    session.lastSeenTokens = { ...newTokens };

    // Update global tokens with delta only
    globalTokens.totalInput += delta.input;
    globalTokens.totalOutput += delta.output;
    globalTokens.totalCacheRead += delta.cacheRead;
    globalTokens.totalCacheCreation += delta.cacheCreation;

    // Calculate context usage (input + cache = total context sent to Claude)
    const MAX_CONTEXT = 200000;
    const currentContext = newTokens.input + newTokens.cacheRead;
    session.contextUsage = {
      current: currentContext,
      max: MAX_CONTEXT,
      percent: Math.round((currentContext / MAX_CONTEXT) * 100)
    };

    // Broadcast token update
    broadcast({
      type: 'token_update',
      sessionId,
      tokens: session.tokens,
      globalTokens,
      delta,
      contextUsage: session.contextUsage
    });
  }

  const session = state.sessions.get(sessionId);

  // Update cwd if provided
  if (event.cwd && !session.cwd) {
    session.cwd = event.cwd;
  }

  session.active = true;
  session.lastActivity = Date.now();

  // Update machine name if it was previously unknown
  if (session.machine === 'unknown' && machineName !== 'unknown') {
    session.machine = machineName;
    session.color = machine.color;
    machine.sessions.add(sessionId);
    broadcast({
      type: 'session_update',
      sessionId,
      machine: machineName,
      color: machine.color
    });
  }

  // Set thinking state when processing an event
  setSessionThinking(sessionId, true);

  // Tool colors
  const TOOL_COLORS = {
    'Read': '#4a9eff',      // blue
    'Write': '#ff6b6b',     // red
    'Edit': '#ffd93d',      // yellow
    'Glob': '#a78bfa',      // purple
    'Grep': '#2dd4bf',      // teal
    'Task': '#fb923c',      // orange
    'WebFetch': '#f472b6',  // pink
    'WebSearch': '#e879f9', // magenta
    'LSP': '#34d399',       // emerald
    'NotebookEdit': '#fbbf24' // amber
  };

  // File interaction
  const fileTools = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'LSP', 'NotebookEdit'];
  if (fileTools.includes(event.tool)) {
    let filePath = event.filePath || event.file_path || (event.input && event.input.file_path);
    // For Glob/Grep, use pattern or path
    if (!filePath && event.tool === 'Glob') filePath = event.input?.pattern || 'glob:*';
    if (!filePath && event.tool === 'Grep') filePath = event.input?.pattern || 'grep:*';

    if (filePath) {
      const fileName = path.basename(filePath);
      const folders = getFolderHierarchy(filePath, session.cwd);

      // Create/update folder nodes
      let parentPath = null;
      folders.forEach(folder => {
        if (!state.folders.has(folder.path)) {
          state.folders.set(folder.path, {
            sessions: new Set(),
            children: new Set(),
            name: folder.name,
            depth: folder.depth
          });
        }
        const folderNode = state.folders.get(folder.path);
        folderNode.sessions.add(sessionId);

        // Link parent folder to this folder
        if (parentPath && state.folders.has(parentPath)) {
          state.folders.get(parentPath).children.add(folder.path);
        }
        parentPath = folder.path;
      });

      // Link last folder to file
      const parentFolder = folders.length > 0 ? folders[folders.length - 1].path : null;

      if (!state.files.has(filePath)) {
        state.files.set(filePath, {
          sessions: new Set(),
          name: fileName,
          parentFolder,
          x: Math.random() * 700 + 50,
          y: Math.random() * 500 + 50,
          lastInteraction: null
        });
      }

      const file = state.files.get(filePath);
      file.sessions.add(sessionId);
      file.parentFolder = parentFolder;
      session.files.add(filePath);

      const color = TOOL_COLORS[event.tool] || '#888888';
      file.lastInteraction = { type: event.tool, color, time: Date.now() };

      broadcast({
        type: 'file_interaction',
        sessionId,
        filePath,
        fileName,
        parentFolder,
        folders: folders.map(f => ({ path: f.path, name: f.name, depth: f.depth })),
        interaction: event.tool,
        color,
        file: { ...file, sessions: Array.from(file.sessions) }
      });
    }
  }

  // Web interactions (WebFetch, WebSearch)
  if (event.tool === 'WebFetch' || event.tool === 'WebSearch') {
    const url = event.input?.url || event.input?.query || 'web';
    const webId = `web_${sessionId}_${Date.now()}`;

    broadcast({
      type: 'web_interaction',
      sessionId,
      webId,
      tool: event.tool,
      url: url.substring(0, 50),
      color: TOOL_COLORS[event.tool]
    });
  }

  // Task/Subagent interactions
  if (event.tool === 'Task') {
    const taskDesc = event.input?.description || 'subagent';
    broadcast({
      type: 'task_interaction',
      sessionId,
      description: taskDesc,
      color: TOOL_COLORS['Task']
    });
  }

  // Terminal/Bash interaction - one terminal per session
  if (event.tool === 'Bash') {
    const terminalId = `term_${sessionId}`;
    const command = event.command || (event.input && event.input.command) || 'unknown';

    const isNew = !state.terminals.has(terminalId);

    state.terminals.set(terminalId, {
      sessionId,
      command: command.substring(0, 50),
      machine: machineName,
      x: isNew ? Math.random() * 700 + 50 : state.terminals.get(terminalId).x,
      y: isNew ? Math.random() * 500 + 50 : state.terminals.get(terminalId).y,
      time: Date.now()
    });
    session.terminals.add(terminalId);

    broadcast({
      type: 'terminal_interaction',
      sessionId,
      terminalId,
      command: command.substring(0, 50),
      isNew,
      terminal: state.terminals.get(terminalId)
    });
  }
}

// Watch Claude history file - only for new events, not loading old history
const historyPath = path.join(process.env.HOME, '.claude', 'history.jsonl');
let lastSize = 0;

function watchHistory() {
  if (!fs.existsSync(historyPath)) {
    console.log('Waiting for Claude history file...');
    setTimeout(watchHistory, 5000);
    return;
  }

  // Start from current file size - don't load old history
  const stats = fs.statSync(historyPath);
  lastSize = stats.size;
  console.log('Starting from current history position:', lastSize);

  const watcher = chokidar.watch(historyPath, { persistent: true });

  watcher.on('change', () => {
    const newStats = fs.statSync(historyPath);
    if (newStats.size > lastSize) {
      const stream = fs.createReadStream(historyPath, {
        start: lastSize,
        encoding: 'utf8'
      });

      let buffer = '';
      stream.on('data', chunk => {
        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop(); // Keep incomplete line

        lines.forEach(line => {
          if (line.trim()) {
            const event = parseHistoryLine(line);
            if (event) processEvent(event);
          }
        });
      });

      lastSize = newStats.size;
    }
  });

  console.log('Watching Claude history:', historyPath);
}

// Also watch for tool calls in real-time via Claude's project files
const claudeProjectPath = path.join(process.env.HOME, '.claude', 'projects');

function watchProjects() {
  if (!fs.existsSync(claudeProjectPath)) {
    return;
  }

  const watcher = chokidar.watch(claudeProjectPath, {
    persistent: true,
    depth: 3,
    ignoreInitial: true
  });

  watcher.on('all', (event, filePath) => {
    if (filePath.includes('history') || filePath.endsWith('.jsonl')) {
      // New activity detected
      broadcast({ type: 'activity_pulse' });
    }
  });
}

// Check for inactive sessions periodically
setInterval(() => {
  const now = Date.now();
  const sessionsToRemove = [];

  state.sessions.forEach((session, sessionId) => {
    const timeSinceActivity = now - session.lastActivity;

    // Mark as inactive after 30 seconds
    if (session.active && timeSinceActivity > SESSION_INACTIVE_TIMEOUT) {
      session.active = false;
      session.thinking = false;
      broadcast({ type: 'session_active', sessionId, active: false });
    }

    // Remove session after 5 minutes of inactivity
    if (timeSinceActivity > SESSION_REMOVE_TIMEOUT) {
      sessionsToRemove.push(sessionId);
    }
  });

  // Remove old sessions and their orphaned files/terminals/folders
  sessionsToRemove.forEach(sessionId => {
    const session = state.sessions.get(sessionId);
    if (session) {
      const filesToRemove = [];
      const foldersToRemove = [];

      // Remove files only used by this session
      session.files.forEach(filePath => {
        const file = state.files.get(filePath);
        if (file) {
          file.sessions.delete(sessionId);
          if (file.sessions.size === 0) {
            state.files.delete(filePath);
            filesToRemove.push(filePath);
          }
        }
      });

      // Broadcast file removals
      filesToRemove.forEach(filePath => {
        broadcast({ type: 'file_remove', filePath });
      });

      // Clean up folders - remove session from folder, delete if empty
      state.folders.forEach((folder, folderPath) => {
        folder.sessions.delete(sessionId);
        if (folder.sessions.size === 0) {
          foldersToRemove.push(folderPath);
        }
      });

      // Remove empty folders and broadcast
      foldersToRemove.forEach(folderPath => {
        state.folders.delete(folderPath);
        broadcast({ type: 'folder_remove', folderPath });
      });

      // Remove terminals
      session.terminals.forEach(termId => {
        state.terminals.delete(termId);
        broadcast({ type: 'terminal_remove', terminalId: termId });
      });

      // Remove from machine's session list
      const machine = state.machines.get(session.machine);
      if (machine) {
        machine.sessions.delete(sessionId);
      }

      // Subtract session tokens from global tokens
      if (session.tokens) {
        globalTokens.totalInput -= session.tokens.input || 0;
        globalTokens.totalOutput -= session.tokens.output || 0;
        globalTokens.totalCacheRead -= session.tokens.cacheRead || 0;
        globalTokens.totalCacheCreation -= session.tokens.cacheCreation || 0;

        // Ensure no negative values
        globalTokens.totalInput = Math.max(0, globalTokens.totalInput);
        globalTokens.totalOutput = Math.max(0, globalTokens.totalOutput);
        globalTokens.totalCacheRead = Math.max(0, globalTokens.totalCacheRead);
        globalTokens.totalCacheCreation = Math.max(0, globalTokens.totalCacheCreation);
      }

      state.sessions.delete(sessionId);
      broadcast({ type: 'session_remove', sessionId, globalTokens });
    }
  });
}, 5000);

// WebSocket connection
wss.on('connection', (ws) => {
  console.log('Client connected');

  // Send current state
  ws.send(JSON.stringify({
    type: 'init',
    machines: Array.from(state.machines.entries()).map(([name, m]) => ({
      name,
      color: m.color,
      sessionCount: m.sessions.size
    })),
    sessions: Array.from(state.sessions.entries()).map(([id, s]) => ({
      id,
      active: s.active,
      thinking: s.thinking,
      waiting: s.waiting,
      waitingTool: s.waitingTool,
      lastActivity: s.lastActivity,
      machine: s.machine,
      color: s.color,
      tokens: s.tokens,
      x: s.x,
      y: s.y,
      files: Array.from(s.files),
      terminals: Array.from(s.terminals)
    })),
    files: Array.from(state.files.entries()).map(([path, f]) => ({
      path,
      ...f,
      sessions: Array.from(f.sessions)
    })),
    terminals: Array.from(state.terminals.entries()).map(([id, t]) => ({ id, ...t })),
    globalTokens
  }));

  ws.on('close', () => console.log('Client disconnected'));
});

// Serve static files
app.use(express.static('public'));

// Serve install script
app.get('/install.sh', (req, res) => {
  const script = `#!/bin/bash
# Claude Constellation - Install Script (Project-Level)
# Run from any project directory: curl -fsSL http://localhost:3333/install.sh | bash

set -e

# Configuration
CONSTELLATION_SERVER="\${CONSTELLATION_SERVER:-http://localhost:3333}"
HOOK_DIR="$HOME/.claude-constellation"
HOOK_SCRIPT="$HOOK_DIR/send-event.sh"
PROJECT_DIR="$(pwd)"
PROJECT_SETTINGS="$PROJECT_DIR/.claude/settings.local.json"

echo "🌌 Claude Constellation - Hook Installer"
echo "========================================="
echo "Server: $CONSTELLATION_SERVER"
echo "Project: $PROJECT_DIR"
echo ""

# Create hook directory
mkdir -p "$HOOK_DIR"

# Create the hook script (global, reused by all projects)
cat > "$HOOK_SCRIPT" << 'HOOKEOF'
#!/bin/bash
# Claude Constellation Hook - sends tool events with token usage
CONSTELLATION_SERVER="\${CONSTELLATION_SERVER:-http://localhost:3333}"
MACHINE_NAME="\${CONSTELLATION_MACHINE:-$(hostname -s)}"

# Read hook input from stdin
INPUT=$(cat)

# Extract transcript_path to get token usage
TRANSCRIPT_PATH=$(echo "$INPUT" | jq -r '.transcript_path // empty' 2>/dev/null)

# Extract CUMULATIVE token usage from transcript (sum all usage entries)
TOKEN_DATA='{}'
if [ -n "$TRANSCRIPT_PATH" ] && [ -f "$TRANSCRIPT_PATH" ]; then
  TOKEN_DATA=$(grep '"usage"' "$TRANSCRIPT_PATH" 2>/dev/null | jq -s '
    reduce .[].message.usage as $u ({input_tokens:0, output_tokens:0, cache_read:0, cache_creation:0};
      .input_tokens += ($u.input_tokens // 0) |
      .output_tokens += ($u.output_tokens // 0) |
      .cache_read += ($u.cache_read_input_tokens // 0) |
      .cache_creation += ($u.cache_creation_input_tokens // 0)
    )
  ' 2>/dev/null || echo '{}')
fi

# Add machine name and token data
ENHANCED=$(echo "$INPUT" | jq -c \\
  --arg machine "$MACHINE_NAME" \\
  --argjson tokens "$TOKEN_DATA" \\
  '. + {machine_name: $machine, tokens: $tokens}' 2>/dev/null)

# Fallback if jq fails - manually construct JSON with machine_name
if [ -z "$ENHANCED" ] || [ "$ENHANCED" = "null" ]; then
  ENHANCED=$(echo "$INPUT" | sed 's/}$/,"machine_name":"'"$MACHINE_NAME"'","tokens":{}}/')
fi

# Send to constellation server in background
curl -s -X POST "$CONSTELLATION_SERVER/api/hook" -H "Content-Type: application/json" -d "$ENHANCED" &>/dev/null &
exit 0
HOOKEOF

chmod +x "$HOOK_SCRIPT"
echo "✅ Created hook script: $HOOK_SCRIPT"

# Check for jq dependency
if ! command -v jq &> /dev/null; then
  echo "⚠️  Warning: jq is not installed. Token tracking won't work."
  echo "   Install with: sudo apt install jq (Linux) or brew install jq (Mac)"
fi

# Create .claude directory if needed
mkdir -p "$PROJECT_DIR/.claude"

# Update or create .claude/settings.local.json
if [ -f "$PROJECT_SETTINGS" ]; then
  # Backup existing config
  cp "$PROJECT_SETTINGS" "$PROJECT_SETTINGS.bak"

  # Add/update hooks using jq
  jq --arg hook "$HOOK_SCRIPT" '
    .hooks.PostToolUse = [{"matcher": "*", "hooks": [{"type": "command", "command": $hook}]}] |
    .hooks.PermissionRequest = [{"matcher": "*", "hooks": [{"type": "command", "command": $hook}]}]
  ' "$PROJECT_SETTINGS" > "$PROJECT_SETTINGS.tmp" && mv "$PROJECT_SETTINGS.tmp" "$PROJECT_SETTINGS"

  echo "✅ Updated $PROJECT_SETTINGS (backup: .bak)"
else
  # Create new config
  cat > "$PROJECT_SETTINGS" << CONFIGEOF
{
  "hooks": {
    "PostToolUse": [{"matcher": "*", "hooks": [{"type": "command", "command": "$HOOK_SCRIPT"}]}],
    "PermissionRequest": [{"matcher": "*", "hooks": [{"type": "command", "command": "$HOOK_SCRIPT"}]}]
  }
}
CONFIGEOF
  echo "✅ Created $PROJECT_SETTINGS"
fi

# Ensure .claude/settings.local.json is gitignored
GITIGNORE="$PROJECT_DIR/.gitignore"
if [ -f "$GITIGNORE" ]; then
  if ! grep -q "settings.local.json" "$GITIGNORE" 2>/dev/null; then
    echo "" >> "$GITIGNORE"
    echo "# Claude Code local settings" >> "$GITIGNORE"
    echo ".claude/settings.local.json" >> "$GITIGNORE"
    echo "✅ Added settings.local.json to .gitignore"
  fi
else
  echo "# Claude Code local settings" > "$GITIGNORE"
  echo ".claude/settings.local.json" >> "$GITIGNORE"
  echo "✅ Created .gitignore with settings.local.json"
fi

# Verify installation
echo ""
echo "========================================="
echo "✅ Installation complete!"
echo ""
echo "📍 Hook script: $HOOK_SCRIPT"
echo "📍 Project config: $PROJECT_SETTINGS"
echo ""
echo "🔄 Restart Claude Code to activate"
echo "🌌 View constellation: $CONSTELLATION_SERVER"
echo ""
echo "📊 Features enabled:"
echo "   - Machine name tracking ($(hostname -s))"
echo "   - Token usage (input/output)"
echo "   - Cache hit tracking"
echo "   - Context window percentage"
echo ""
echo "🔧 To customize machine name:"
echo "   export CONSTELLATION_MACHINE='my-custom-name'"
echo ""
echo "🔧 To use a different server:"
echo "   export CONSTELLATION_SERVER='http://your-server:3333'"
`;
  res.type('text/plain').send(script);
});

// API to manually trigger events (for testing)
app.post('/api/event', express.json(), (req, res) => {
  processEvent(req.body);
  res.json({ ok: true });
});

// API to receive hook events from Claude Code
app.post('/api/hook', express.json(), (req, res) => {
  const hookData = req.body;
  const hookEventName = hookData.hook_event_name;
  const sessionId = hookData.session_id || 'claude-session';
  const machineName = hookData.machine_name || 'unknown';

  // Debug logging
  console.log(`[HOOK] ${machineName} | ${hookData.tool_name} | tokens:`, JSON.stringify(hookData.tokens || 'none'));

  // Handle permission request - waiting state
  if (hookEventName === 'PermissionRequest') {
    // Ensure session exists first
    const machine = getOrCreateMachine(machineName);
    if (!state.sessions.has(sessionId)) {
      state.sessions.set(sessionId, {
        files: new Set(),
        terminals: new Set(),
        active: true,
        thinking: false,
        waiting: true,
        waitingTool: hookData.tool_name,
        lastActivity: Date.now(),
        machine: machineName,
        color: machine.color,
        cwd: hookData.cwd || BASE_PATH,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
        x: Math.random() * 600 + 100,
        y: Math.random() * 400 + 100
      });
      machine.sessions.add(sessionId);
      broadcast({
        type: 'session_add',
        sessionId,
        machine: machineName,
        color: machine.color,
        waiting: true,
        waitingTool: hookData.tool_name
      });
    }
    setSessionWaiting(sessionId, true, hookData.tool_name);
    res.json({ ok: true });
    return;
  }

  // Transform hook data to our event format (PostToolUse or other events)
  const event = {
    tool: hookData.tool_name || hookData.tool,
    sessionId: sessionId,
    machine_name: machineName,
    filePath: hookData.tool_input?.file_path,
    file_path: hookData.tool_input?.file_path,
    command: hookData.tool_input?.command,
    input: hookData.tool_input,
    cwd: hookData.cwd || hookData.working_directory || process.env.PWD,
    tokens: hookData.tokens // Token data from enhanced hook
  };

  // Clear waiting state when tool is executed (permission granted)
  if (state.sessions.has(sessionId)) {
    const session = state.sessions.get(sessionId);
    if (session.waiting) {
      setSessionWaiting(sessionId, false, null);
    }
  }

  processEvent(event);
  res.json({ ok: true });
});

// Get current state
app.get('/api/state', (req, res) => {
  res.json({
    machines: Array.from(state.machines.entries()).map(([name, m]) => ({
      name,
      color: m.color,
      sessionCount: m.sessions.size
    })),
    sessions: Array.from(state.sessions.entries()).map(([id, s]) => [id, {
      ...s,
      files: Array.from(s.files),
      terminals: Array.from(s.terminals)
    }]),
    files: Array.from(state.files.entries()).map(([path, f]) => [path, {
      ...f,
      sessions: Array.from(f.sessions)
    }]),
    terminals: Array.from(state.terminals.entries())
  });
});

const PORT = process.env.PORT || 3333;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Constellation server running on http://localhost:${PORT}`);
  watchHistory();
  watchProjects();
});
