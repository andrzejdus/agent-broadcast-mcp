#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
source "$SCRIPT_DIR/start-common.sh"

DOCKERFILE="$SCRIPT_DIR/Dockerfile.claude"
IMAGE="agent-broadcast-claude:local"
AUTH_TARGET="/home/agent/.claude"

if parse_start_arguments claude "$@"; then
  if [ "$LOGIN_MODE" -eq 1 ]; then
    run_login_container "$DOCKERFILE" "$IMAGE" "$AUTH_TARGET" claude auth login
  else
    run_agent_container "$DOCKERFILE" "$IMAGE" "$AUTH_TARGET"
  fi
else
  status=$?
  [ "$status" -eq 2 ] && exit 0
  exit "$status"
fi
