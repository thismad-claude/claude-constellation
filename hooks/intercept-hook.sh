#!/bin/bash
# Hook interceptor - logs full payload to see exact structure

LOG_FILE="/tmp/claude-hooks.log"

# Read full input from stdin
INPUT=$(cat)

# Log with timestamp
echo "=== $(date '+%Y-%m-%d %H:%M:%S') ===" >> "$LOG_FILE"
echo "$INPUT" | jq '.' >> "$LOG_FILE" 2>/dev/null || echo "$INPUT" >> "$LOG_FILE"
echo "" >> "$LOG_FILE"

# Also forward to the real hook
SCRIPT_DIR="$(dirname "$0")"
echo "$INPUT" | "$SCRIPT_DIR/send-event.sh"

exit 0
