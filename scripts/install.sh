#!/bin/bash
# One-time setup for the Colorado Scoreboard v2 launcher.
#
# What this does:
#   1. Resolves the absolute path to `node` (launchd doesn't see your shell's PATH).
#   2. Writes a launchd LaunchAgent plist (KeepAlive supervision) next to this
#      script - NOT into ~/Library/LaunchAgents, so it never auto-loads at
#      login. It's only loaded when Start-Scoreboard.command runs.
#   3. Makes the start/stop .command scripts executable.
#   4. Copies double-clickable launcher icons onto the Desktop.
#
# Safe to re-run any time (e.g. after moving the project, or if `node` was
# reinstalled at a different path) - it just regenerates everything.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LABEL="${SCOREBOARD_LABEL:-com.otters.coloradoscoreboard}"   # launchd label; set SCOREBOARD_LABEL to use your own
PLIST_PATH="$SCRIPT_DIR/$LABEL.plist"
LOG_DIR="$PROJECT_DIR/logs"

NODE_PATH="$(command -v node || true)"
if [ -z "$NODE_PATH" ]; then
    echo "ERROR: could not find 'node' on PATH. Install Node.js first, then re-run this script." >&2
    exit 1
fi

mkdir -p "$LOG_DIR"

echo "Project dir: $PROJECT_DIR"
echo "Node path:   $NODE_PATH"
echo "Plist:       $PLIST_PATH"

cat > "$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>$NODE_PATH</string>
        <string>$PROJECT_DIR/server/index.js</string>
        <string>-7</string>
        <string>-u</string>
        <string>50</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$PROJECT_DIR</string>
    <key>KeepAlive</key>
    <true/>
    <key>RunAtLoad</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>5</integer>
    <key>StandardOutPath</key>
    <string>$LOG_DIR/launchd.out.log</string>
    <key>StandardErrorPath</key>
    <string>$LOG_DIR/launchd.err.log</string>
</dict>
</plist>
PLIST

# Bake the project dir + label into the launcher scripts so they work no
# matter where they're double-clicked from (Desktop copy included).
for script in start-scoreboard.command stop-scoreboard.command start-streaming.command start-stream-day.command; do
    sed -e "s#__PROJECT_DIR__#$PROJECT_DIR#g" -e "s#__LABEL__#$LABEL#g" -e "s#__NODE_PATH__#$NODE_PATH#g" \
        "$SCRIPT_DIR/$script.src" > "$SCRIPT_DIR/$script"
    chmod +x "$SCRIPT_DIR/$script"
done

DESKTOP="$HOME/Desktop"
if [ -d "$DESKTOP" ]; then
    cp "$SCRIPT_DIR/start-scoreboard.command" "$DESKTOP/Start Scoreboard.command"
    cp "$SCRIPT_DIR/stop-scoreboard.command" "$DESKTOP/Stop Scoreboard.command"
    cp "$SCRIPT_DIR/start-streaming.command" "$DESKTOP/Start Streaming.command"
    cp "$SCRIPT_DIR/start-stream-day.command" "$DESKTOP/Start Stream Day.command"
    chmod +x "$DESKTOP/Start Scoreboard.command" "$DESKTOP/Stop Scoreboard.command" "$DESKTOP/Start Streaming.command" "$DESKTOP/Start Stream Day.command"
    echo "Desktop icons installed: 'Start Scoreboard.command', 'Stop Scoreboard.command', 'Start Streaming.command'"
else
    echo "No ~/Desktop found - skipped Desktop icons. Launcher scripts are in $SCRIPT_DIR"
fi

echo ""
echo "Setup complete. Double-click 'Start Scoreboard.command' on the Desktop to begin."
