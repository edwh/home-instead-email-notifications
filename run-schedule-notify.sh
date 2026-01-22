#!/bin/bash
# Cron wrapper for Home Instead schedule notification
# Recommended: run once daily in the morning, e.g., 0 7 * * *

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_FILE="$SCRIPT_DIR/schedule-notify.log"

cd "$SCRIPT_DIR"
echo "$(date): Running schedule notification" >> "$LOG_FILE"
node schedule-notify.js >> "$LOG_FILE" 2>&1
echo "$(date): Completed" >> "$LOG_FILE"
