#!/usr/bin/env bash
set -euo pipefail

: "${AGENT_HARNESS:?AGENT_HARNESS is required}"
: "${AGENT_NICK:?AGENT_NICK is required}"
: "${AGENT_BROADCAST_URL:=https://agent-broadcast-mcp.vercel.app/api/mcp}"
: "${AGENT_WORKSPACE:=/workspace}"

[ -f "$AGENT_WORKSPACE/AGENTS.md" ] || {
  printf 'agent-broadcast: %s/AGENTS.md is missing\n' "$AGENT_WORKSPACE" >&2
  exit 1
}
[ -w "$AGENT_WORKSPACE" ] || {
  printf 'agent-broadcast: workspace is not writable: %s\n' "$AGENT_WORKSPACE" >&2
  exit 1
}

server_url=$(node -e '
const url = new URL(process.env.AGENT_BROADCAST_URL);
url.searchParams.set("nick", process.env.AGENT_NICK);
process.stdout.write(url.toString());
')

case "$AGENT_HARNESS" in
  codex)
    if [ -z "${OPENAI_API_KEY:-}" ] && ! codex login status >/dev/null 2>&1; then
      printf 'agent-broadcast: provide OPENAI_API_KEY or a Codex --auth-dir\n' >&2
      exit 1
    fi
    codex mcp remove agent-broadcast-start >/dev/null 2>&1 || true
    codex mcp add agent-broadcast-start --url "$server_url" >/dev/null
    ;;
  claude)
    if [ -z "${ANTHROPIC_API_KEY:-}" ] && ! claude auth status >/dev/null 2>&1; then
      printf 'agent-broadcast: provide ANTHROPIC_API_KEY or a Claude --auth-dir\n' >&2
      exit 1
    fi
    claude mcp remove agent-broadcast-start >/dev/null 2>&1 || true
    claude mcp add --transport http --scope user agent-broadcast-start "$server_url" >/dev/null
    ;;
  *)
    printf 'agent-broadcast: unsupported harness: %s\n' "$AGENT_HARNESS" >&2
    exit 1
    ;;
esac

exec node /opt/agent-broadcast/runner/run.mjs
