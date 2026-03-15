"""
MMS Forced Alignment Server
============================
Loads the MMS_FA model once on startup, handles alignment requests via HTTP.

Endpoints:
  POST /align  { "wav_path": "...", "word": "...", "phonemes": ["HH","AY",...],
                 "hint_start": 4.5, "hint_end": 5.2 }
  GET  /health  -> {"status": "ready"}
  POST /shutdown -> graceful shutdown

hint_start/hint_end: optional timing from wav2vec2 to narrow the alignment window.
When audio is much longer than the target word (e.g. full sentence), the hint
tells us exactly where the word is so MMS can do precise alignment.

Usage: python align_server.py [port]
Default port: 5050
"""
import sys
import json
import os
import signal
import traceback

import torch
import torchaudio
import scipy.io.wavfile as wavfile
import numpy as np
from http.server import HTTPServer, BaseHTTPRequestHandler
from threading import Thread

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 5050

VOWELS = {
    'AA', 'AE', 'AH', 'AO', 'AW', 'AY',
    'EH', 'ER', 'EY', 'IH', 'IY',
    'OW', 'OY', 'UH', 'UW',
}

# Digraph phonemes that map to 2 characters in the MMS alphabet
DIGRAPHS = {'TH', 'DH', 'CH', 'JH', 'SH', 'ZH', 'NG'}

# ─── Load model ONCE on startup ────────────────────────────────────────
print("[AlignServer] Loading MMS_FA model...", flush=True)
device = torch.device("cpu")
bundle = torchaudio.pipelines.MMS_FA
model = bundle.get_model().to(device)
DICTIONARY = bundle.get_dict()
print(f"[AlignServer] Model loaded. Dictionary: {len(DICTIONARY)} chars", flush=True)


# ─── Audio loading ─────────────────────────────────────────────────────
def load_audio(wav_path: str) -> tuple[torch.Tensor, int]:
    """Load WAV file and return (waveform [1, T], sample_rate)."""
    sr, audio_np = wavfile.read(wav_path)

    # Normalize to float32 [-1, 1]
    if audio_np.dtype == np.int16:
        audio_np = audio_np.astype(np.float32) / 32768.0
    elif audio_np.dtype == np.int32:
        audio_np = audio_np.astype(np.float32) / 2147483648.0
    elif audio_np.dtype != np.float32:
        audio_np = audio_np.astype(np.float32)

    waveform = torch.from_numpy(audio_np).unsqueeze(0)

    # Ensure mono
    if waveform.ndim == 3:
        waveform = waveform[:, :, 0]

    # Resample to model's expected rate
    if sr != bundle.sample_rate:
        waveform = torchaudio.functional.resample(waveform, sr, bundle.sample_rate)

    return waveform, bundle.sample_rate


# ─── Core alignment ───────────────────────────────────────────────────
def do_alignment(
    wav_path: str,
    word: str,
    phonemes_arpabet: list[str],
    hint_start: float | None = None,
    hint_end: float | None = None,
) -> dict:
    """
    Run MMS forced alignment on a WAV file.

    Args:
        wav_path: Path to WAV file
        word: Target word (e.g. "hypothesis")
        phonemes_arpabet: ARPAbet phoneme list (e.g. ["HH","AY","P","AA",...])
        hint_start: Optional start time hint from wav2vec2 (seconds)
        hint_end: Optional end time hint from wav2vec2 (seconds)

    Returns:
        dict with 'word', 'phonemes', 'vowels' keys
    """
    # Load and prepare audio
    waveform, sr = load_audio(wav_path)

    # Run MMS model to get emission probabilities
    with torch.inference_mode():
        emission, _ = model(waveform.to(device))

    # ratio: seconds per frame
    ratio = waveform.shape[1] / emission.shape[1] / sr
    audio_duration = waveform.shape[1] / sr
    total_frames = emission.shape[1]

    # ── Trim to hint window if provided ──
    full_emission = emission
    frame_offset = 0

    if hint_start is not None and hint_end is not None:
        pad = 0.5  # padding in seconds
        trim_start_sec = max(0.0, hint_start - pad)
        trim_end_sec = min(audio_duration, hint_end + pad)

        trim_start_frame = max(0, int(trim_start_sec / ratio))
        trim_end_frame = min(total_frames, int(trim_end_sec / ratio))

        # Only trim if the window is meaningful
        if trim_end_frame > trim_start_frame + 5:
            print(
                f"[AlignServer] Hint: {hint_start:.2f}-{hint_end:.2f}s "
                f"-> window {trim_start_sec:.2f}-{trim_end_sec:.2f}s "
                f"({trim_end_frame - trim_start_frame} frames)",
                flush=True,
            )
            emission = full_emission[:, trim_start_frame:trim_end_frame, :]
            frame_offset = trim_start_frame

    # ── Tokenize word for MMS ──
    transcript = word.lower()
    chars = [c for c in transcript if c in DICTIONARY]
    if not chars:
        print(f"[AlignServer] No valid chars in '{word}'", flush=True)
        return {"word": word, "phonemes": [], "vowels": []}

    tokens = [DICTIONARY[c] for c in chars]

    # Safety: if emission too short for tokens, fall back to full audio
    min_frames_needed = len(tokens) * 2
    if emission.shape[1] < min_frames_needed:
        print(
            f"[AlignServer] Emission too short ({emission.shape[1]} < {min_frames_needed}), "
            f"falling back to full audio ({total_frames} frames)",
            flush=True,
        )
        emission = full_emission
        frame_offset = 0

    # ── Run forced alignment ──
    token_tensor = torch.tensor([tokens], dtype=torch.int32)
    try:
        aligned_tokens, scores = torchaudio.functional.forced_align(
            emission, token_tensor, blank=0
        )
    except Exception as e:
        print(f"[AlignServer] forced_align error: {e}", flush=True)
        return {"word": word, "phonemes": [], "vowels": []}

    # ── Extract character alignments ──
    alignments = _extract_char_alignments(aligned_tokens, scores, chars, frame_offset, ratio)

    # ── Map characters -> phonemes -> vowels ──
    phoneme_ranges = _map_chars_to_phonemes(alignments, phonemes_arpabet)
    _expand_vowel_ranges(phoneme_ranges)
    vowel_ranges = _build_vowel_list(phoneme_ranges)

    return {
        "word": word,
        "phonemes": phoneme_ranges,
        "vowels": vowel_ranges,
    }


def _extract_char_alignments(
    aligned_tokens: torch.Tensor,
    scores: torch.Tensor,
    chars: list[str],
    frame_offset: int,
    ratio: float,
) -> list[dict]:
    """Extract per-character time alignments from forced_align output."""
    alignments = []
    token_idx = 0
    i = 0
    n_frames = aligned_tokens.shape[1]

    while i < n_frames:
        if aligned_tokens[0, i] != 0:
            start_frame = i
            current_token = aligned_tokens[0, i].item()
            while i < n_frames and aligned_tokens[0, i] == current_token:
                i += 1
            end_frame = i

            if token_idx < len(chars):
                alignments.append({
                    "char": chars[token_idx],
                    "start": round((start_frame + frame_offset) * ratio, 4),
                    "end": round((end_frame + frame_offset) * ratio, 4),
                    "score": round(scores[0, start_frame:end_frame].mean().item(), 3),
                })
                token_idx += 1
        else:
            i += 1

    return alignments


def _map_chars_to_phonemes(
    alignments: list[dict], phonemes_arpabet: list[str]
) -> list[dict]:
    """Map character-level alignments to ARPAbet phonemes."""
    phoneme_ranges = []
    ci = 0  # character index

    for phoneme in phonemes_arpabet:
        if ci >= len(alignments):
            break

        if phoneme in DIGRAPHS and ci + 1 < len(alignments):
            # Digraph: merge 2 characters
            phoneme_ranges.append({
                "phoneme": phoneme,
                "start": alignments[ci]["start"],
                "end": alignments[ci + 1]["end"],
                "is_vowel": phoneme in VOWELS,
            })
            ci += 2
        else:
            phoneme_ranges.append({
                "phoneme": phoneme,
                "start": alignments[ci]["start"],
                "end": alignments[ci]["end"],
                "is_vowel": phoneme in VOWELS,
            })
            ci += 1

    return phoneme_ranges


def _expand_vowel_ranges(phoneme_ranges: list[dict]) -> None:
    """Expand vowel boundaries to fill gaps between consonants.
    Each vowel absorbs from the previous consonant's end to the next consonant's start.
    """
    for i, p in enumerate(phoneme_ranges):
        if not p["is_vowel"]:
            continue
        if i > 0:
            phoneme_ranges[i]["start"] = phoneme_ranges[i - 1]["end"]
        if i < len(phoneme_ranges) - 1:
            phoneme_ranges[i]["end"] = phoneme_ranges[i + 1]["start"]


def _build_vowel_list(phoneme_ranges: list[dict]) -> list[dict]:
    """Extract vowel ranges with syllable indices."""
    vowel_ranges = []
    syl_idx = 0
    for p in phoneme_ranges:
        if p["is_vowel"]:
            vowel_ranges.append({
                "phoneme": p["phoneme"],
                "start": p["start"],
                "end": p["end"],
                "syllable_index": syl_idx,
            })
            syl_idx += 1
    return vowel_ranges


# ─── HTTP Server ───────────────────────────────────────────────────────
class AlignHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass  # suppress default request logging

    def do_GET(self):
        if self.path == "/health":
            self._json_response(200, {"status": "ready"})
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        if self.path == "/align":
            self._handle_align()
        elif self.path == "/shutdown":
            self._json_response(200, {"status": "shutting_down"})
            Thread(target=lambda: server.shutdown()).start()
        else:
            self.send_response(404)
            self.end_headers()

    def _handle_align(self):
        try:
            body = self._read_json()
            result = do_alignment(
                wav_path=body["wav_path"],
                word=body["word"],
                phonemes_arpabet=body["phonemes"],
                hint_start=body.get("hint_start"),
                hint_end=body.get("hint_end"),
            )
            self._json_response(200, result)
        except (ConnectionAbortedError, BrokenPipeError):
            pass  # client disconnected
        except Exception as e:
            print(f"[AlignServer] Error: {e}", flush=True)
            traceback.print_exc()
            try:
                self._json_response(500, {"error": str(e)})
            except (ConnectionAbortedError, BrokenPipeError):
                pass

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length", 0))
        return json.loads(self.rfile.read(length))

    def _json_response(self, code: int, data: dict):
        body = json.dumps(data).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


# ─── Main ──────────────────────────────────────────────────────────────
if __name__ == "__main__":
    server = HTTPServer(("127.0.0.1", PORT), AlignHandler)
    print(f"[AlignServer] Listening on http://127.0.0.1:{PORT}", flush=True)
    print("[AlignServer] READY", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    server.server_close()
    print("[AlignServer] Stopped.", flush=True)
