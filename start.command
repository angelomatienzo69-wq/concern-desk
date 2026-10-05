#!/bin/bash
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Opening the download page - install the LTS version, then double-click this file again."
  open https://nodejs.org/en/download
  read -p "Press Enter to close"; exit 1
fi
echo "Starting Concern Desk... keep this window open. Close it to stop the server."
(sleep 2; open http://localhost:3000) &
node server.js
