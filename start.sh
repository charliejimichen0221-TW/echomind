#!/bin/bash
# start.sh — Entrypoint for HuggingFace Spaces Docker container
# Starts both the Node.js server and the Python alignment server

echo "🚀 Starting EchoMind..."

# Start the Python alignment server in the background
echo "🐍 Starting Alignment Server (port 5050)..."
python3 scripts/align_server.py 5050 &
ALIGN_PID=$!

# Wait for alignment server to be ready (max 120s)
echo "⏳ Waiting for Alignment Server to load model..."
for i in $(seq 1 120); do
  if curl -s http://127.0.0.1:5050/health > /dev/null 2>&1; then
    echo "✅ Alignment Server ready!"
    break
  fi
  sleep 1
done

# Start the Node.js server (production mode)
echo "🌐 Starting Node.js server (port 7860)..."
NODE_ENV=production ECHOMIND_DEBUG=1 node server_prod.js
