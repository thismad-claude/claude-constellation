#!/bin/bash
# Claude Code hook to send tool events to constellation server
# This runs after each tool call

# Read the tool info from stdin
TOOL_DATA=$(cat)

# Extract tool name and send to constellation server
curl -s -X POST http://localhost:3333/api/event \
  -H "Content-Type: application/json" \
  -d "$TOOL_DATA" > /dev/null 2>&1 &
