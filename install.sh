#!/bin/bash
# Claude Constellation - Install Script (Project-Level)
# Run from any project directory: bash install.sh
# Or curl: curl -fsSL http://YOUR_SERVER_IP:3333/install.sh | bash

set -e

# Configuration
CONSTELLATION_SERVER="${CONSTELLATION_SERVER:-http://localhost:3333}"
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
CONSTELLATION_SERVER="${CONSTELLATION_SERVER:-http://localhost:3333}"
MACHINE_NAME="${CONSTELLATION_MACHINE:-$(hostname -s)}"

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
ENHANCED=$(echo "$INPUT" | jq -c \
  --arg machine "$MACHINE_NAME" \
  --argjson tokens "$TOKEN_DATA" \
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
