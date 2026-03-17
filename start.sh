#!/bin/bash
# start.sh — Entrypoint for Docker container
# Starts the alignment server, speech server, and Node.js server

echo "🚀 Starting EchoMind..."

# Start the Python alignment server in the background
echo "🐍 Starting Alignment Server (port 5050)..."
python3 scripts/align_server.py 5050 &
ALIGN_PID=$!

# Start the Speech Server (STT + TTS) in the background
echo "🗣️ Starting Speech Server (port 5051)..."
python3 scripts/speech_server.py 5051 &
SPEECH_PID=$!

# Wait for alignment server to be ready (max 120s)
echo "⏳ Waiting for Alignment Server to load model..."
for i in $(seq 1 120); do
  if curl -s http://127.0.0.1:5050/health > /dev/null 2>&1; then
    echo "✅ Alignment Server ready!"
    break
  fi
  sleep 1
done

# Wait for speech server to be ready (max 60s)
echo "⏳ Waiting for Speech Server to load Whisper model..."
for i in $(seq 1 60); do
  if curl -s http://127.0.0.1:5051/health > /dev/null 2>&1; then
    echo "✅ Speech Server ready!"
    break
  fi
  sleep 1
done

# Start the Node.js server (production mode) using tsx
echo "🌐 Starting Node.js server (port 7860)..."
PORT=7860 NODE_ENV=production ECHOMIND_DEBUG=1 npx tsx server.ts
