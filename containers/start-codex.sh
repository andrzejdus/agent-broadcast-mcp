#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
source "$SCRIPT_DIR/start-common.sh"

if parse_start_arguments codex "$@"; then
  run_agent_container \
    "$SCRIPT_DIR/Dockerfile.codex" \
    "agent-broadcast-codex:local" \
    "/home/agent/.codex"
else
  status=$?
  [ "$status" -eq 2 ] && exit 0
  exit "$status"
fi
