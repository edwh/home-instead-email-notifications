#!/bin/bash
# Cron wrapper for Home Instead activity log scraper
# Kills any existing instance before starting a new one

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="$SCRIPT_DIR/scraper.pid"
LOG_FILE="$SCRIPT_DIR/scraper.log"

# Kill any existing instance
if [ -f "$PID_FILE" ]; then
    OLD_PID=$(cat "$PID_FILE")
    if ps -p "$OLD_PID" > /dev/null 2>&1; then
        echo "$(date): Killing previous instance (PID $OLD_PID)" >> "$LOG_FILE"
        kill "$OLD_PID" 2>/dev/null
        sleep 2
        # Force kill if still running
        if ps -p "$OLD_PID" > /dev/null 2>&1; then
            kill -9 "$OLD_PID" 2>/dev/null
        fi
    fi
    rm -f "$PID_FILE"
fi

# Start new instance
cd "$SCRIPT_DIR"
echo "$(date): Starting scraper" >> "$LOG_FILE"
node scraper.js >> "$LOG_FILE" 2>&1 &
NEW_PID=$!
echo "$NEW_PID" > "$PID_FILE"
echo "$(date): Started with PID $NEW_PID" >> "$LOG_FILE"
