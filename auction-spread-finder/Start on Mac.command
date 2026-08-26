#!/bin/bash
# Double-click this file to start the app.
# The first run takes a minute while it installs; after that it's a few seconds.

cd "$(dirname "$0")" || exit 1

echo ""
echo "  Auction Spread Finder"
echo "  ---------------------"
echo ""

if ! command -v node >/dev/null 2>&1; then
  echo "  Node.js isn't installed yet."
  echo ""
  echo "  1. Go to  https://nodejs.org"
  echo "  2. Download the big green LTS button and run the installer."
  echo "  3. Come back and double-click this file again."
  echo ""
  read -r -p "  Press Return to close. "
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "  First run — installing (about a minute)..."
  npm install --silent || { echo "  Install failed."; read -r -p "  Press Return to close. "; exit 1; }
  echo "  Done."
  echo ""
fi

# Open the browser once the server is actually accepting connections.
(
  for _ in $(seq 1 40); do
    if curl -s -o /dev/null "http://localhost:4317"; then
      open "http://localhost:4317"
      exit 0
    fi
    sleep 0.5
  done
) &

echo "  Starting. Your browser will open in a moment."
echo "  Keep this window open while you use the app."
echo "  Close it or press Control-C when you're done."
echo ""

npm start
