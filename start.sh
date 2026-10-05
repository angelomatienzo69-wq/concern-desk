#!/bin/bash
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "Install Node.js 22.13+ from https://nodejs.org first."; exit 1; }
(sleep 2; xdg-open http://localhost:3000 >/dev/null 2>&1) &
node server.js
