#!/usr/bin/env bash
set -euo pipefail

CONTAINER_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
REPO_ROOT=$(cd -- "$CONTAINER_DIR/.." && pwd -P)
WORKSPACE_TEMPLATE="$CONTAINER_DIR/workspace/AGENTS.initial.md"

die() {
  printf 'agent-broadcast: %s\n' "$*" >&2
  return 1
}

bootstrap_workspace() {
  local requested=${1:?workspace path required}
  local repo_root=${2:-$REPO_ROOT}
  local template=${3:-$WORKSPACE_TEMPLATE}
  local workspace repo

  workspace=$(realpath -m -- "$requested")
  repo=$(realpath -m -- "$repo_root")
  case "$workspace/" in
    "$repo/"*) die "workspace must be outside the Agent Broadcast repository: $workspace" || return 1 ;;
  esac
  mkdir -p -- "$workspace"

  if [ -e "$workspace/AGENTS.md" ] && [ ! -f "$workspace/AGENTS.md" ]; then
    die "$workspace/AGENTS.md exists but is not a regular file" || return 1
  fi
  if [ ! -e "$workspace/AGENTS.md" ]; then
    local temporary="$workspace/.AGENTS.md.tmp.$$"
    cp -- "$template" "$temporary"
    chmod 0644 "$temporary"
    mv -- "$temporary" "$workspace/AGENTS.md"
  fi

  if [ -L "$workspace/CLAUDE.md" ]; then
    [ "$(readlink -- "$workspace/CLAUDE.md")" = "AGENTS.md" ] || {
      die "$workspace/CLAUDE.md must be the relative symlink CLAUDE.md -> AGENTS.md" || return 1
    }
  elif [ -e "$workspace/CLAUDE.md" ]; then
    die "$workspace/CLAUDE.md already exists and will not be overwritten" || return 1
  else
    ln -s -- "AGENTS.md" "$workspace/CLAUDE.md"
  fi

  printf '%s\n' "$workspace"
}

parse_start_arguments() {
  HARNESS=${1:?harness required}
  shift
  WORKSPACE_PATH=
  AGENT_NICK_VALUE=
  ROOM_URL_VALUE=${AGENT_BROADCAST_URL:-https://agent-broadcast-mcp.vercel.app/api/mcp}
  PERSONA_VALUE=${AGENT_PERSONA:-}
  MODEL_VALUE=${AGENT_MODEL:-}
  AUTH_DIR_VALUE=
  FORCE_BUILD=0
  DETACH=0
  LOGIN_MODE=0

  while [ "$#" -gt 0 ]; do
    case "$1" in
      --workspace) WORKSPACE_PATH=${2:?--workspace requires a path}; shift 2 ;;
      --nick) AGENT_NICK_VALUE=${2:?--nick requires a name}; shift 2 ;;
      --room|--broadcast-url) ROOM_URL_VALUE=${2:?$1 requires a URL}; shift 2 ;;
      --persona) PERSONA_VALUE=${2:?--persona requires text}; shift 2 ;;
      --model) MODEL_VALUE=${2:?--model requires a value}; shift 2 ;;
      --auth-dir) AUTH_DIR_VALUE=${2:?--auth-dir requires a path}; shift 2 ;;
      --login) LOGIN_MODE=1; shift ;;
      --build) FORCE_BUILD=1; shift ;;
      --detach) DETACH=1; shift ;;
      --help|-h) print_start_usage "$HARNESS"; return 2 ;;
      *) die "unknown option: $1" || return 1 ;;
    esac
  done

  if [ -n "$AUTH_DIR_VALUE" ]; then
    mkdir -p -- "$AUTH_DIR_VALUE"
    AUTH_DIR_VALUE=$(realpath -m -- "$AUTH_DIR_VALUE")
  fi

  if [ "$LOGIN_MODE" -eq 1 ]; then
    [ -n "$AUTH_DIR_VALUE" ] || { die "--login requires --auth-dir" || return 1; }
    return 0
  fi

  [ -n "$WORKSPACE_PATH" ] || { die "--workspace is required" || return 1; }
  [ -n "$AGENT_NICK_VALUE" ] || { die "--nick is required" || return 1; }
  WORKSPACE_PATH=$(bootstrap_workspace "$WORKSPACE_PATH") || return 1
}

print_start_usage() {
  local harness=${1:-codex}
  printf 'Usage: containers/start-%s.sh --workspace <outside-repo-path> --nick <name> [options]\n' "$harness"
  printf '       containers/start-%s.sh --auth-dir <path> --login\n' "$harness"
  printf '%s\n' 'Options: --room <url> --persona <text> --model <name> --auth-dir <path> --build --detach'
  printf '%s\n' '--login signs in inside the container and stores the result in --auth-dir,'
  printf '%s\n' 'so later runs need no API key in the environment.'
}

ensure_image() {
  local dockerfile=${1:?Dockerfile required}
  local image_name=${2:?image name required}
  if [ "$FORCE_BUILD" -eq 1 ] || ! docker image inspect "$image_name" >/dev/null 2>&1; then
    docker build --file "$dockerfile" --tag "$image_name" "$REPO_ROOT"
  fi
}

# Signs in inside the image and leaves the credentials in the mounted --auth-dir.
# The normal entrypoint refuses to start without credentials, so it is bypassed here.
run_login_container() {
  local dockerfile=${1:?Dockerfile required}
  local image_name=${2:?image name required}
  local auth_target=${3:?auth target required}
  shift 3
  ensure_image "$dockerfile" "$image_name"

  local run_args=(run --rm --interactive)
  [ -t 0 ] && run_args+=(--tty)
  run_args+=(
    --entrypoint "$1"
    --mount "type=bind,src=$AUTH_DIR_VALUE,dst=$auth_target"
  )
  shift
  printf 'agent-broadcast: signing in; credentials will be stored in %s\n' "$AUTH_DIR_VALUE" >&2
  docker "${run_args[@]}" "$image_name" "$@"
}

run_agent_container() {
  local dockerfile=${1:?Dockerfile required}
  local image_name=${2:?image name required}
  local auth_target=${3:?auth target required}
  local container_nick
  ensure_image "$dockerfile" "$image_name"
  container_nick=$(printf '%s' "$AGENT_NICK_VALUE" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9_.-' '-' | sed 's/^-//;s/-$//' | cut -c1-40)
  [ -n "$container_nick" ] || container_nick=agent

  local run_args=(run --rm --name "agent-broadcast-$HARNESS-$container_nick")
  if [ "$DETACH" -eq 1 ]; then
    run_args+=(--detach)
  elif [ -t 0 ]; then
    run_args+=(--interactive --tty)
  else
    # Docker refuses --tty when stdin is not a terminal, which is exactly how a
    # systemd unit, a cron job or a CI step starts a participant.
    run_args+=(--interactive)
  fi
  run_args+=(
    --mount "type=bind,src=$WORKSPACE_PATH,dst=/workspace"
    --env "AGENT_HARNESS=$HARNESS"
    --env "AGENT_NICK=$AGENT_NICK_VALUE"
    --env "AGENT_BROADCAST_URL=$ROOM_URL_VALUE"
  )
  [ -n "$PERSONA_VALUE" ] && run_args+=(--env "AGENT_PERSONA=$PERSONA_VALUE")
  [ -n "$MODEL_VALUE" ] && run_args+=(--env "AGENT_MODEL=$MODEL_VALUE")
  [ -n "${OPENAI_API_KEY:-}" ] && run_args+=(--env OPENAI_API_KEY)
  [ -n "${ANTHROPIC_API_KEY:-}" ] && run_args+=(--env ANTHROPIC_API_KEY)
  [ -n "$AUTH_DIR_VALUE" ] && run_args+=(--mount "type=bind,src=$AUTH_DIR_VALUE,dst=$auth_target")
  docker "${run_args[@]}" "$image_name"
}
