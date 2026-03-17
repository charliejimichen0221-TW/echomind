"""
Speech Server (STT + TTS)
==========================
Provides Speech-to-Text (via faster-whisper) and Text-to-Speech (via edge-tts)
endpoints for the EchoMind China edition.

Endpoints:
  POST /stt  { "wav_path": "..." }  -> { "text": "...", "language": "en" }
  POST /tts  { "text": "...", "voice": "en-US-AriaNeural" }  -> { "wav_path": "..." }
  GET  /health  -> { "status": "ready" }

Usage: python speech_server.py [port]
Default port: 5051
"""
import sys
import json
import os
import tempfile
import traceback
import asyncio
import subprocess

from http.server import HTTPServer, BaseHTTPRequestHandler
from threading import Thread

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 5051

# ─── Load Whisper model ONCE on startup ─────────────────────────────
print("[SpeechServer] Loading faster-whisper model...", flush=True)
from faster_whisper import WhisperModel

# Use 'base' model for speed, 'small' for better accuracy
WHISPER_MODEL_SIZE = os.environ.get("WHISPER_MODEL", "base")
whisper_model = WhisperModel(WHISPER_MODEL_SIZE, device="cpu", compute_type="int8")
print(f"[SpeechServer] Whisper '{WHISPER_MODEL_SIZE}' model loaded.", flush=True)

# ─── Check edge-tts availability ────────────────────────────────────
try:
    result = subprocess.run(
        [sys.executable, "-m", "edge_tts", "--list-voices"],
        capture_output=True, text=True, timeout=15
    )
    if result.returncode == 0:
        print("[SpeechServer] edge-tts available.", flush=True)
    else:
        print(f"[SpeechServer] WARNING: edge-tts not working: {result.stderr[:200]}", flush=True)
except Exception as e:
    print(f"[SpeechServer] WARNING: edge-tts check failed: {e}", flush=True)

# ─── STT: Transcribe audio using faster-whisper ─────────────────────
def transcribe_audio(wav_path: str) -> dict:
    """Transcribe a WAV file to text using faster-whisper."""
    try:
        segments, info = whisper_model.transcribe(
            wav_path,
            language="en",
            beam_size=5,
            vad_filter=True,
            vad_parameters=dict(min_silence_duration_ms=500),
        )
        
        text_parts = []
        for segment in segments:
            text_parts.append(segment.text.strip())
        
        full_text = " ".join(text_parts).strip()
        print(f"[SpeechServer] STT: '{full_text}' (lang={info.language}, prob={info.language_probability:.2f})", flush=True)
        
        return {
            "text": full_text,
            "language": info.language,
            "probability": round(info.language_probability, 3),
        }
    except Exception as e:
        print(f"[SpeechServer] STT error: {e}", flush=True)
        traceback.print_exc()
        return {"text": "", "error": str(e)}

# ─── TTS: Synthesize speech using edge-tts ──────────────────────────
def synthesize_speech(text: str, voice: str = "en-US-AriaNeural", rate: str = "+0%") -> dict:
    """Synthesize text to speech using edge-tts. Returns path to WAV file."""
    try:
        # Create temp file for output
        temp_mp3 = tempfile.mktemp(suffix=".mp3", dir=tempfile.gettempdir())
        temp_wav = tempfile.mktemp(suffix=".wav", dir=tempfile.gettempdir())
        
        # Run edge-tts as subprocess
        cmd = [
            sys.executable, "-m", "edge_tts",
            "--voice", voice,
            "--rate", rate,
            "--text", text,
            "--write-media", temp_mp3,
        ]
        
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        if result.returncode != 0:
            print(f"[SpeechServer] TTS edge-tts error: {result.stderr[:300]}", flush=True)
            return {"error": result.stderr[:300]}
        
        # Convert MP3 to WAV (16kHz mono PCM16) using ffmpeg
        ffmpeg_cmd = [
            "ffmpeg", "-y", "-i", temp_mp3,
            "-ar", "24000", "-ac", "1", "-sample_fmt", "s16",
            temp_wav,
        ]
        
        ffresult = subprocess.run(ffmpeg_cmd, capture_output=True, text=True, timeout=15)
        
        # Clean up mp3
        if os.path.exists(temp_mp3):
            os.remove(temp_mp3)
        
        if ffresult.returncode != 0:
            print(f"[SpeechServer] TTS ffmpeg error: {ffresult.stderr[:300]}", flush=True)
            return {"error": "ffmpeg conversion failed"}
        
        file_size = os.path.getsize(temp_wav)
        duration = (file_size - 44) / 2 / 24000  # 24kHz 16-bit mono
        print(f"[SpeechServer] TTS: '{text[:50]}...' -> {temp_wav} ({duration:.1f}s, {file_size} bytes)", flush=True)
        
        return {
            "wav_path": temp_wav,
            "duration": round(duration, 2),
            "sample_rate": 24000,
        }
    except Exception as e:
        print(f"[SpeechServer] TTS error: {e}", flush=True)
        traceback.print_exc()
        return {"error": str(e)}


# ─── HTTP Request Handler ───────────────────────────────────────────
class SpeechHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass  # Suppress default logging

    def _json_response(self, data, status=200):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(json.dumps(data).encode())

    def _read_body(self) -> dict:
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length)
        return json.loads(body)

    def do_GET(self):
        if self.path == "/health":
            self._json_response({"status": "ready"})
        else:
            self._json_response({"error": "not found"}, 404)

    def do_POST(self):
        try:
            if self.path == "/stt":
                data = self._read_body()
                wav_path = data.get("wav_path", "")
                if not wav_path or not os.path.exists(wav_path):
                    self._json_response({"error": "wav_path not found"}, 400)
                    return
                result = transcribe_audio(wav_path)
                self._json_response(result)

            elif self.path == "/tts":
                data = self._read_body()
                text = data.get("text", "")
                voice = data.get("voice", "en-US-AriaNeural")
                rate = data.get("rate", "+0%")
                if not text:
                    self._json_response({"error": "text is required"}, 400)
                    return
                result = synthesize_speech(text, voice, rate)
                self._json_response(result)

            else:
                self._json_response({"error": "not found"}, 404)

        except Exception as e:
            traceback.print_exc()
            self._json_response({"error": str(e)}, 500)

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()


# ─── Start server ───────────────────────────────────────────────────
if __name__ == "__main__":
    server = HTTPServer(("127.0.0.1", PORT), SpeechHandler)
    print(f"[SpeechServer] Listening on http://127.0.0.1:{PORT}", flush=True)
    print("[SpeechServer] READY", flush=True)
    
    def handle_shutdown(signum, frame):
        print("[SpeechServer] Shutting down...", flush=True)
        server.shutdown()
        sys.exit(0)
    
    signal.signal(signal.SIGTERM, handle_shutdown)
    signal.signal(signal.SIGINT, handle_shutdown)
    
    server.serve_forever()
