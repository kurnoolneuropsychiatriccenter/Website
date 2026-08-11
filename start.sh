#!/usr/bin/env bash
# Kurnool Neuro Psychiatric and ENT Center - Clinic Software Launcher
# For Mac / Linux users. Run:  bash start.sh

set -e
cd "$(dirname "$0")"

echo ""
echo "========================================================"
echo "  Kurnool Neuro Psychiatric and ENT Center"
echo "  Clinic Software Launcher"
echo "========================================================"
echo ""

if ! command -v node >/dev/null 2>&1; then
  echo "[ERROR] Node.js is not installed. Install Node LTS v20 from https://nodejs.org"
  exit 1
fi

echo "Node.js version: $(node -v)"
echo ""

if [ ! -d "node_modules" ]; then
  echo "First-time setup: installing packages..."
  npm install
fi

echo ""
echo "Starting Clinic Software on http://localhost:3000 ..."
echo "Press Ctrl+C to stop."
echo ""
node server.js
