#!/bin/zsh
# Tar bort alla scheman som install.sh har skapat
PREFIX="com.erikjin.claude-runner"
for plist in "$HOME/Library/LaunchAgents/$PREFIX".*.plist(N); do
  launchctl bootout "gui/$(id -u)/${plist:t:r}" 2>/dev/null || true
  rm -f "$plist"
  echo "Borttagen: ${plist:t:r}"
done
