#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
source "$SCRIPT_DIR/start-common.sh"

DOCKERFILE="$SCRIPT_DIR/Dockerfile.codex"
IMAGE="agent-broadcast-codex:local"
AUTH_TARGET="/home/agent/.codex"

if parse_start_arguments codex "$@"; then
  if [ "$LOGIN_MODE" -eq 1 ]; then
    # The browser callback flow binds a container-local port nobody can reach;
    # --device-auth is the flow that works from inside a container.
    run_login_container "$DOCKERFILE" "$IMAGE" "$AUTH_TARGET" codex login --device-auth
  else
    run_agent_container "$DOCKERFILE" "$IMAGE" "$AUTH_TARGET"
  fi
else
  status=$?
  [ "$status" -eq 2 ] && exit 0
  exit "$status"
fi
