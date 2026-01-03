# Claude Constellation

Real-time 3D visualization of Claude Code activity across all machines in a Tailscale network.

## Architecture

```
┌─────────────────┐     PostToolUse Hook      ┌─────────────────┐     WebSocket      ┌─────────────────┐
│  Machine 1      │ ────────────────────────► │                 │ ◄───────────────► │                 │
│  (Mac/PC/VPS)   │                           │  VPS:3333       │                   │  Browser        │
├─────────────────┤     POST /api/hook        │  Express +      │     Real-time     │  3D Force Graph │
│  Machine 2      │ ────────────────────────► │  WebSocket      │     Updates       │  THREE.js       │
│  (any device)   │                           │  Server         │                   │  Visualization  │
└─────────────────┘                           └─────────────────┘                   └─────────────────┘
```

## Key Files

| File | Role |
|------|------|
| `src/server.js` | Express + WebSocket server, processes events, manages state, folder hierarchy |
| `public/index.html` | 3D visualization with THREE.js, 3d-force-graph, SpriteText labels |
| `hooks/send-event.sh` | Hook script that sends tool events to server (installed on each machine) |
| `docker-compose.yml` | Docker deployment config (port 3333) |
| `Dockerfile` | Node.js 20 Alpine image |

## Features Implemented

### Core Visualization
- **3D Force-Directed Graph** using `3d-force-graph` library
- **THREE.js** for custom node rendering and effects
- **WebSocket** for real-time updates (no page refresh)
- **Position preservation** - nodes keep their position on updates

### Node Types
| Node | Shape | Color | Label |
|------|-------|-------|-------|
| Brain (Session) | Sphere with glow + ring (size scales with tokens) | Machine color (pink default) | Hostname + token stats |
| File | Small sphere | Action color | Filename |
| Folder | Octahedron | Grey (#666) | Folder name |
| Terminal | Cube | Green (#4ade80) | Last command (truncated) |

### Per-Agent Token Display
Each brain shows its own token usage:
- **Size** - logarithmically scales with total tokens (bigger = more usage)
- **Label** - Shows `X tok | Y% cache` below hostname
- **Tooltip** - Hover for detailed breakdown:
  - Input tokens, Output tokens
  - Cache Read, Cache Created

### Action Colors (Legend)
- **Blue (#4a9eff)** - Read
- **Red (#ff6b6b)** - Write
- **Yellow (#ffd93d)** - Edit
- **Purple (#a78bfa)** - Glob
- **Teal (#2dd4bf)** - Grep
- **Pink (#f472b6)** - WebFetch
- **Green (#4ade80)** - Terminal/Bash

### Folder Hierarchy
- Files in subfolders show full path: `Brain → folder → subfolder → file`
- Paths are relative to session's working directory (cwd)
- Folder nodes are grey octahedrons
- Automatic folder creation from file paths

### Animations
- **Brain pulsing** - Active sessions have pulsing ring (machine color)
- **Brain thinking** - Purple glow when Claude is thinking
- **Brain waiting** - Orange pulsing glow + rotating octagon ring when waiting for user permission
- **File pulsing** - Subtle scale animation
- **Folder rotating** - Gentle rotation
- **Link flash** - White burst with particles when action occurs
- **Stars background** - 5000 stars with twinkling
- **Dust particles** - 200 floating particles
- **Token bursts** - Particle explosions when tokens are used:
  - Yellow burst for output tokens
  - Blue burst for input tokens
  - Green burst for cache hits

### Brain States
| State | Visual | Trigger |
|-------|--------|---------|
| Idle | Dim glow | No activity for 30s |
| Active | Pulsing ring (machine color) | Tool executed |
| Thinking | Purple glow + pulse | Processing response |
| Waiting | Orange glow + rotating ring | Permission dialog shown |

### Links
- **Always grey (#444)** when idle
- **White flash** with 30 particles when action occurs
- **Orange pulsing** when waiting for terminal permission (Bash)
  - Pulsing opacity (0.5 → 1.0)
  - Pulsing width (2 → 4)
  - 15 orange particles flowing at moderate speed
- **Constant particle flow** (2 particles) on all links

### UI Elements
- **Stats bar** - Brain/File/Terminal counts + Token stats
- **Token counter (⚡)** - Total tokens used (input + output), pulses on activity
- **Cache hit rate (💾)** - Percentage of cache read vs total input
- **Connection status** - WebSocket connected/disconnected
- **Machine badges** - Bottom-left, shows all connected machines with colors
- **Action legend** - Bottom-right, color reference
- **Tooltip** - On hover, shows node details

## How to Run

```bash
# Local dev
node src/server.js

# Docker (production)
sudo docker compose up -d --build

# IMPORTANT: After Docker restart, re-add iptables rule for Tailscale access
sudo iptables -I DOCKER-USER -s 100.64.0.0/10 -j ACCEPT

# View logs
sudo docker logs claude-constellation
```

## How to Test

```bash
# Simulate file read event
curl -X POST http://localhost:3333/api/hook \
  -H "Content-Type: application/json" \
  -d '{"tool_name":"Read","session_id":"test","machine_name":"my-pc","tool_input":{"file_path":"/home/user/project/src/app.js"}}'

# Simulate bash command
curl -X POST http://localhost:3333/api/hook \
  -H "Content-Type: application/json" \
  -d '{"tool_name":"Bash","session_id":"test","machine_name":"my-pc","tool_input":{"command":"npm install"}}'

# Check state
curl http://localhost:3333/api/state | python3 -m json.tool
```

## Multi-Machine Setup

Install hook on any machine with Claude Code:
```bash
curl -fsSL http://YOUR_SERVER_IP:3333/install.sh | bash
```

This installs the PostToolUse hook that sends events to the constellation server.

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | 3D Visualization UI |
| `/api/state` | GET | Current state JSON (sessions, files, folders, terminals) |
| `/api/hook` | POST | Receive tool events from hooks |
| `/install.sh` | GET | Installation script for other machines |

## WebSocket Events

### Server → Client
- `init` - Full state on connect
- `session_add/update/remove` - Session changes
- `file_interaction` - File touched (includes folder hierarchy)
- `terminal_interaction` - Bash command executed
- `session_thinking` - Claude thinking state
- `session_active` - Session active state
- `machine_add` - New machine connected

### Event Data Structure
```javascript
// file_interaction
{
  type: 'file_interaction',
  sessionId: 'uuid',
  filePath: '/full/path/to/file.js',
  fileName: 'file.js',
  parentFolder: '/full/path/to',
  folders: [
    { path: '/full', name: 'full', depth: 0 },
    { path: '/full/path', name: 'path', depth: 1 },
    { path: '/full/path/to', name: 'to', depth: 2 }
  ],
  color: '#4a9eff',
  interaction: 'Read'
}

// token_update
{
  type: 'token_update',
  sessionId: 'uuid',
  tokens: { input: 5000, output: 1500, cacheRead: 45000, cacheCreation: 500 },
  globalTokens: { totalInput: 10000, totalOutput: 3000, totalCacheRead: 90000, totalCacheCreation: 1000 },
  delta: { input: 500, output: 100, cacheRead: 4000, cacheCreation: 0 }
}
```

### Token Data Flow
1. Hook script (`send-event.sh`) reads the session transcript file (`transcript_path`)
2. Extracts latest `usage` data from API responses in the transcript
3. Sends token data with each hook event to the server
4. Server tracks per-session and global token totals
5. Frontend displays counters and animates token bursts

## State Management

- **Sessions**: Active Claude instances, tracked by session_id
- **Files**: Touched files with action history
- **Folders**: Auto-created from file paths
- **Terminals**: One per session, shows last command
- **Machines**: Unique hostnames with assigned colors

### Auto-cleanup
- Sessions become inactive after 30 seconds of no activity
- Inactive sessions removed after 5 minutes

## Tech Stack

- **Backend**: Node.js, Express, ws (WebSocket)
- **Frontend**:
  - `three@0.160.0` - 3D rendering
  - `3d-force-graph@1.73.0` - Force-directed graph
  - `three-spritetext@1.8.2` - Text labels
- **Deployment**: Docker, Alpine Linux

## Machine Colors

Machines get auto-assigned colors, with specific overrides:
- `agentvps`: Yellow (#fbbf24)
- Default rotation: pink, green, blue, light pink, purple, yellow, teal, red

## Current Status

**Deployed**: Running in Docker on port 3333
- Public: http://YOUR_PUBLIC_IP:3333
- Tailscale: http://YOUR_TAILSCALE_IP:3333

**Hook installed**: `~/.claude-constellation/send-event.sh`
- Configured in `~/.claude.json` for PostToolUse and PermissionRequest events

## Known Issues / TODO

- [x] Token usage visualization (implemented via hook transcript parsing)
- [x] Cache hit/miss indicators (shows cache hit rate %)
- [x] Context window percentage display (shows X% ctx)
- [ ] Cost tracking display (USD estimate)
- [ ] Auto camera drift (disabled, can enable)
- [ ] Mobile touch controls optimization

## Troubleshooting

### Tailscale not connecting after Docker restart
```bash
sudo iptables -I DOCKER-USER -s 100.64.0.0/10 -j ACCEPT
```

### Session shows "unknown" machine name
This happens when a session was created before the hook started sending `machine_name`. Fix by restarting the container to clear stale sessions:
```bash
sudo docker restart claude-constellation
```
New events will create sessions with the correct machine name from `hostname -s`.

### THREE.js version conflicts
Must use compatible versions:
- `three@0.160.0`
- `3d-force-graph@1.73.0`

### Nodes resetting position
Fixed by using persistent `nodeMap`/`linkMap` instead of rebuilding graph

### Check what server is receiving
```bash
sudo docker logs claude-constellation --tail 20
# Shows: [HOOK] machine_name | tool_name | tokens: {...}
```

### Check current state
```bash
curl -s http://localhost:3333/api/state | jq '.sessions[] | {id: .[0], machine: .[1].machine}'
```
