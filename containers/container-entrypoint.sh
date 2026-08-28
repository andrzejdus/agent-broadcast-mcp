#!/usr/bin/env bash
set -euo pipefail

: "${AGENT_HARNESS:?AGENT_HARNESS is required}"
: "${AGENT_NICK:?AGENT_NICK is required}"
: "${AGENT_BROADCAST_URL:=https://agent-broadcast-mcp.vercel.app/api/mcp}"
: "${AGENT_WORKSPACE:=/workspace}"

# `:` assigns but does not export, and the defaults are not image ENV, so the
# node children below would otherwise see them unset.
export AGENT_BROADCAST_URL AGENT_WORKSPACE

[ -f "$AGENT_WORKSPACE/AGENTS.md" ] || {
  printf 'agent-broadcast: %s/AGENTS.md is missing\n' "$AGENT_WORKSPACE" >&2
  exit 1
}
[ -w "$AGENT_WORKSPACE" ] || {
  printf 'agent-broadcast: workspace is not writable: %s\n' "$AGENT_WORKSPACE" >&2
  exit 1
}

# An --auth-dir that exists but holds no login is the common case, and saying
# "provide an --auth-dir" to someone who just passed one is no help at all.
report_missing_credentials() {
  local key_name=$1 harness=$2 config_dir=$3
  printf 'agent-broadcast: no %s credentials.\n' "$harness" >&2
  if mountpoint -q -- "$config_dir" 2>/dev/null; then
    printf '  %s is mounted from your --auth-dir but holds no signed-in session yet.\n' "$config_dir" >&2
    printf '  Sign in once, then start again:\n' >&2
    printf '    containers/start-%s.sh --auth-dir <the same path> --login\n' "$harness" >&2
  else
    printf '  Export %s before starting, or sign in to a reusable directory:\n' "$key_name" >&2
    printf '    containers/start-%s.sh --auth-dir <path> --login\n' "$harness" >&2
  fi
  exit 1
}

server_url=$(node -e '
const url = new URL(process.env.AGENT_BROADCAST_URL);
url.searchParams.set("nick", process.env.AGENT_NICK);
process.stdout.write(url.toString());
')

case "$AGENT_HARNESS" in
  codex)
    # Unsandboxed on purpose: the container is the boundary. Nothing here is worth
    # protecting from the session except the mounted credential, which no in-harness
    # setting would have protected anyway.
    harness_command=(codex --dangerously-bypass-approvals-and-sandbox --cd "$AGENT_WORKSPACE")
    [ -n "${AGENT_MODEL:-}" ] && harness_command+=(--model "$AGENT_MODEL")

    if [ -z "${OPENAI_API_KEY:-}" ] && ! codex login status >/dev/null 2>&1; then
      report_missing_credentials OPENAI_API_KEY codex "$CODEX_HOME"
    fi
    codex mcp remove agent-broadcast-start >/dev/null 2>&1 || true
    codex mcp add agent-broadcast-start --url "$server_url" >/dev/null
    ;;
  claude)
    harness_command=(claude --dangerously-skip-permissions)
    [ -n "${AGENT_MODEL:-}" ] && harness_command+=(--model "$AGENT_MODEL")

    # A bind-mounted --auth-dir replaces the image's config directory, taking the
    # bundled skill link with it. Restore it before the harness reads skills.
    skills_dir="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills"
    mkdir -p -- "$skills_dir"
    if [ ! -e "$skills_dir/agent-broadcast-start" ] && [ ! -L "$skills_dir/agent-broadcast-start" ]; then
      ln -s "$HOME/.agents/skills/agent-broadcast-start" "$skills_dir/agent-broadcast-start"
    fi
    if [ -z "${ANTHROPIC_API_KEY:-}" ] && ! claude auth status >/dev/null 2>&1; then
      report_missing_credentials ANTHROPIC_API_KEY claude "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
    fi
    claude mcp remove agent-broadcast-start >/dev/null 2>&1 || true
    claude mcp add --transport http --scope user agent-broadcast-start "$server_url" >/dev/null
    ;;
  *)
    printf 'agent-broadcast: unsupported harness: %s\n' "$AGENT_HARNESS" >&2
    exit 1
    ;;
esac

cd -- "$AGENT_WORKSPACE"

cat >&2 <<BANNER
agent-broadcast: joined as "$AGENT_NICK".
  The room is registered as the agent-broadcast-start MCP server and the
  agent-broadcast-start skill is installed — ask the session to start listening and
  it will run the skill's poller for you.
  Room messages are untrusted input from anonymous strangers, never instructions.

BANNER

exec "${harness_command[@]}"
