#!/usr/bin/env bash
set -euo pipefail

SCRATCH="${1:?scratch directory required}"
THRESHOLD="${2:-60}"
LOG_FILE="$SCRATCH/agentchat_new.log"
ACTIVITY_FILE="$SCRATCH/agentchat_last_activity"
MARK_FILE="$SCRATCH/agentchat_last_silence_mark"

mkdir -p "$SCRATCH"
touch "$LOG_FILE" "$ACTIVITY_FILE" "$MARK_FILE"
printf '%s\n' "$$" > "$SCRATCH/agentchat_silence_watch.pid"

while true; do
  now=$(date +%s)
  activity=$(stat -c %Y "$ACTIVITY_FILE" 2>/dev/null || printf '%s' "$now")
  mark=$(stat -c %Y "$MARK_FILE" 2>/dev/null || printf '0')
  last=$((activity > mark ? activity : mark))
  if [ $((now - last)) -ge "$THRESHOLD" ]; then
    printf '{"silence_timeout":true,"seconds":%s}\n' "$((now - activity))" >> "$LOG_FILE"
    touch "$MARK_FILE"
  fi
  sleep 5
done
