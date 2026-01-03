#!/bin/bash
# Claude Constellation - Install Hook Script
# Run this on any machine to connect to the constellation
#
# Usage: curl -fsSL http://YOUR_SERVER_IP:3333/install.sh | bash
# Or:    bash install-hook.sh

set -e

CONSTELLATION_SERVER="${CONSTELLATION_SERVER:-http://localhost:3333}"
HOOK_DIR="$HOME/.claude-constellation"
HOOK_SCRIPT="$HOOK_DIR/send-event.sh"
CLAUDE_CONFIG="$HOME/.claude.json"

echo "🌌 Installing Claude Constellation Hook..."
echo "   Server: $CONSTELLATION_SERVER"

# Create hook directory
mkdir -p "$HOOK_DIR"

# Create hook script
cat > "$HOOK_SCRIPT" << 'HOOKEOF'
#!/bin/bash
# Claude Constellation Hook - sends tool events to central server
CONSTELLATION_SERVER="${CONSTELLATION_SERVER:-http://localhost:3333}"
MACHINE_NAME="${CONSTELLATION_MACHINE:-$(hostname -s)}"

INPUT=$(cat)
ENHANCED=$(echo "$INPUT" | jq -c --arg machine "$MACHINE_NAME" '. + {machine_name: $machine}' 2>/dev/null || echo "$INPUT")

curl -s -X POST "$CONSTELLATION_SERVER/api/hook" \
  -H "Content-Type: application/json" \
  -d "$ENHANCED" > /dev/null 2>&1 &
exit 0
HOOKEOF

chmod +x "$HOOK_SCRIPT"
echo "✅ Hook script created: $HOOK_SCRIPT"

# Check if jq is installed
if ! command -v jq &> /dev/null; then
    echo "⚠️  jq not found. Installing..."
    if command -v brew &> /dev/null; then
        brew install jq
    elif command -v apt-get &> /dev/null; then
        sudo apt-get install -y jq
    else
        echo "❌ Please install jq manually: https://stedolan.github.io/jq/download/"
    fi
fi

# Update Claude config
if [ -f "$CLAUDE_CONFIG" ]; then
    # Backup existing config
    cp "$CLAUDE_CONFIG" "$CLAUDE_CONFIG.bak"

    # Check if hooks already exist
    if grep -q '"hooks"' "$CLAUDE_CONFIG"; then
        echo "⚠️  Hooks already exist in $CLAUDE_CONFIG"
        echo "   Please manually add this to your PostToolUse hooks:"
        echo ""
        echo '   {"type": "command", "command": "'$HOOK_SCRIPT'"}'
        echo ""
    else
        # Add hooks to config using jq
        if command -v jq &> /dev/null; then
            jq --arg hook "$HOOK_SCRIPT" '.hooks = {
                "PostToolUse": [{
                    "matcher": {},
                    "hooks": [{
                        "type": "command",
                        "command": $hook
                    }]
                }]
            }' "$CLAUDE_CONFIG" > "$CLAUDE_CONFIG.tmp" && mv "$CLAUDE_CONFIG.tmp" "$CLAUDE_CONFIG"
            echo "✅ Claude config updated: $CLAUDE_CONFIG"
        else
            echo "⚠️  jq not available. Please manually add hooks to $CLAUDE_CONFIG"
        fi
    fi
else
    # Create new config
    cat > "$CLAUDE_CONFIG" << CONFIGEOF
{
    "hooks": {
        "PostToolUse": [{
            "matcher": {},
            "hooks": [{
                "type": "command",
                "command": "$HOOK_SCRIPT"
            }]
        }]
    }
}
CONFIGEOF
    echo "✅ Claude config created: $CLAUDE_CONFIG"
fi

echo ""
echo "🎉 Installation complete!"
echo ""
echo "📋 Next steps:"
echo "   1. Restart Claude Code (new sessions will report to constellation)"
echo "   2. View constellation: $CONSTELLATION_SERVER"
echo ""
echo "🔧 To customize:"
echo "   export CONSTELLATION_MACHINE=\"my-laptop\"  # Custom machine name"
echo "   export CONSTELLATION_SERVER=\"http://...\"  # Different server"
