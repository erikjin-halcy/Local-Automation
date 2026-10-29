#!/bin/zsh
LABEL="com.erikjin.claude-runner"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
echo "Avinstallerad."
