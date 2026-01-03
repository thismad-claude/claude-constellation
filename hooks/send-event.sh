#!/bin/bash
# Claude Constellation Hook - sends tool events with token usage
CONSTELLATION_SERVER="${CONSTELLATION_SERVER:-http://localhost:3333}"
MACHINE_NAME="${CONSTELLATION_MACHINE:-$(hostname -s)}"

# Read hook input from stdin
INPUT=$(cat)

# Extract transcript_path to get token usage
TRANSCRIPT_PATH=$(echo "$INPUT" | jq -r '.transcript_path // empty' 2>/dev/null)

# Extract token usage from transcript if available
TOKEN_DATA='{}'
if [ -n "$TRANSCRIPT_PATH" ] && [ -f "$TRANSCRIPT_PATH" ]; then
  TOKEN_DATA=$(tail -20 "$TRANSCRIPT_PATH" 2>/dev/null | grep '"usage"' | tail -1 | jq -c '{
    input_tokens: .message.usage.input_tokens,
    output_tokens: .message.usage.output_tokens,
    cache_read: .message.usage.cache_read_input_tokens,
    cache_creation: .message.usage.cache_creation_input_tokens
  }' 2>/dev/null || echo '{}')
fi

# Add machine name and token data
ENHANCED=$(echo "$INPUT" | jq -c \
  --arg machine "$MACHINE_NAME" \
  --argjson tokens "$TOKEN_DATA" \
  '. + {machine_name: $machine, tokens: $tokens}' 2>/dev/null || echo "$INPUT")

# Send to constellation server in background
curl -s -X POST "$CONSTELLATION_SERVER/api/hook" -H "Content-Type: application/json" -d "$ENHANCED" &>/dev/null &
exit 0
