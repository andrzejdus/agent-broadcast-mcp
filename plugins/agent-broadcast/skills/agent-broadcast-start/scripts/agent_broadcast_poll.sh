#!/usr/bin/env bash
set -euo pipefail

URL="${1:?room URL required}"
SCRATCH="${2:?scratch directory required}"
START_AFTER_ID="${3:-0}"
OWN_NICK="${4:-}"

STATE_FILE="$SCRATCH/agent_broadcast_last_id"
LOG_FILE="$SCRATCH/agent_broadcast_new.log"
ACTIVITY_FILE="$SCRATCH/agent_broadcast_last_activity"
POLL_SECONDS="${AGENT_BROADCAST_POLL_SECONDS:-5}"

mkdir -p "$SCRATCH"
last_id=$(cat "$STATE_FILE" 2>/dev/null || printf '%s' "$START_AFTER_ID")
touch "$LOG_FILE" "$ACTIVITY_FILE"
printf '%s\n' "$$" > "$SCRATCH/agent_broadcast_poll.pid"

if command -v sha256sum >/dev/null 2>&1; then
  script_hash=$(sha256sum "${BASH_SOURCE[0]}" | cut -c1-12)
else
  script_hash=unknown
fi
printf 'pid=%s started=%s script_sha256_prefix=%s\n' "$$" "$(date -Iseconds)" "$script_hash" > "$SCRATCH/agent_broadcast_poll.status"

while true; do
  while true; do
    response=$(curl --silent --show-error --max-time 12 --request POST "$URL" \
      --header "Content-Type: application/json" \
      --header "Accept: application/json, text/event-stream" \
      --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"chat_read\",\"arguments\":{\"after_id\":$last_id,\"limit\":1000}}}" \
      2>/dev/null || true)

    result=$(printf '%s' "$response" | OWN_NICK="$OWN_NICK" LAST_ID="$last_id" python3 -c '
import json, os, sys
raw = sys.stdin.read()
payloads = [line[5:].strip() for line in raw.splitlines() if line.startswith("data:")]
wire = json.loads(payloads[-1] if payloads else raw)
body = json.loads(wire["result"]["content"][0]["text"])
own = os.environ.get("OWN_NICK", "")
last_id = int(os.environ.get("LAST_ID", "0"))
if body.get("history_truncated"):
    print(json.dumps({"history_truncated": True, "requested_after": last_id}))
for message in body.get("messages", []):
    if not own or message.get("nick") != own:
        print(json.dumps(message, separators=(",", ":")))
print("###CURSOR###" + str(body.get("next_cursor", last_id)))
print("###MORE###" + ("1" if body.get("has_more") else "0"))
' 2>/dev/null || true)

    cursor=$(printf '%s\n' "$result" | sed -n 's/^###CURSOR###//p' | tail -1)
    more=$(printf '%s\n' "$result" | sed -n 's/^###MORE###//p' | tail -1)
    printf '%s\n' "$result" | sed '/^###CURSOR###/d; /^###MORE###/d' >> "$LOG_FILE"
    if [ -n "$cursor" ] && [ "$cursor" -gt "$last_id" ] 2>/dev/null; then
      last_id="$cursor"
      printf '%s\n' "$last_id" > "$STATE_FILE"
      touch "$ACTIVITY_FILE"
    fi
    [ "$more" = "1" ] || break
  done
  sleep "$POLL_SECONDS"
done
