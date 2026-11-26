#!/bin/sh
set -eu
# Virtual display for headful Chromium. Remove a stale lock left in a snapshot.
rm -f /tmp/.X99-lock
Xvfb :99 -screen 0 1280x900x24 -nolisten tcp >/dev/null 2>&1 &
exec node /app/dist/index.js
