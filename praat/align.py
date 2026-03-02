"""
EchoMind Word Alignment Script using faster-whisper
Finds the exact start/end timestamps of a target word in a WAV file.

Usage:
    python align.py <wav_file> <target_word> [--hint]

    --hint flag: provides an initial prompt to Whisper to improve recognition
                 (useful for user audio where pronunciation may be unclear)

Output (JSON):
    {"found": true, "start": 1.23, "end": 2.01, "word": "hypothesis", "confidence": 0.95}
    {"found": false, "error": "Word not found"}
"""

import sys
import json
import os

# Suppress warnings
os.environ["KMP_DUPLICATE_LIB_OK"] = "TRUE"
import warnings
warnings.filterwarnings("ignore")

# Cache the model globally so it's only loaded once per process
_model = None

def get_model():
    global _model
    if _model is None:
        from faster_whisper import WhisperModel
        # Use 'tiny' model — fast and lightweight, --hint compensates for lower accuracy
        # 'base' was causing system resource issues that degraded audio capture
        _model = WhisperModel("tiny", device="cpu", compute_type="int8")
    return _model


def word_similarity(a: str, b: str) -> float:
    """Simple character-level similarity ratio between two words."""
    if not a or not b:
        return 0.0
    a, b = a.lower(), b.lower()
    if a == b:
        return 1.0
    # Require minimum length to avoid matching short words like "I", "a", "the"
    if len(a) < 3 or len(b) < 3:
        return 1.0 if a == b else 0.0
    # Check minimum overlap ratio
    longer = max(len(a), len(b))
    shorter = min(len(a), len(b))
    if shorter / longer < 0.5:
        return 0.0
    # Count matching characters from start
    common = sum(1 for ca, cb in zip(a, b) if ca == cb)
    return common / longer


def get_rms_energy(wav_path: str, start_sec: float, end_sec: float) -> float:
    """Calculate RMS energy of a segment of a WAV file."""
    import wave
    import struct
    try:
        with wave.open(wav_path, 'rb') as w:
            rate = w.getframerate()
            n = w.getnframes()
            w.readframes(0)  # reset
            
            start_frame = max(0, int(start_sec * rate))
            end_frame = min(n, int(end_sec * rate))
            if end_frame <= start_frame:
                return 0.0
            
            w.setpos(start_frame)
            frames = w.readframes(end_frame - start_frame)
            samples = struct.unpack(f'<{len(frames)//2}h', frames)
            
            if not samples:
                return 0.0
            
            rms = (sum(s*s for s in samples) / len(samples)) ** 0.5
            return rms
    except Exception:
        return 0.0


def get_peak_energy(wav_path: str) -> float:
    """Get the peak RMS energy across the entire file (500ms windows)."""
    import wave
    import struct
    try:
        with wave.open(wav_path, 'rb') as w:
            rate = w.getframerate()
            n = w.getnframes()
            frames = w.readframes(n)
            samples = struct.unpack(f'<{len(frames)//2}h', frames)
        
        window = int(rate * 0.5)  # 500ms windows
        max_rms = 0.0
        for i in range(0, len(samples) - window, window // 2):
            chunk = samples[i:i+window]
            rms = (sum(s*s for s in chunk) / len(chunk)) ** 0.5
            if rms > max_rms:
                max_rms = rms
        return max_rms
    except Exception:
        return 0.0


def find_word_in_audio(wav_path: str, target_word: str, use_hint: bool = False) -> dict:
    """Find target word timestamps in audio using Whisper."""
    model = get_model()
    
    # Build transcription options
    transcribe_opts = {
        "language": "en",
        "word_timestamps": True,
        "beam_size": 5,
    }
    
    # For user audio: hint Whisper about what word to expect
    # This dramatically improves recognition of accented or unclear speech
    if use_hint:
        transcribe_opts["initial_prompt"] = f"The speaker is practicing pronunciation of the word: {target_word}. They say: {target_word}."
    
    segments, info = model.transcribe(wav_path, **transcribe_opts)
    
    target_lower = target_word.lower().strip()
    all_words = []
    candidates = []  # (score, word_obj, clean_word)
    
    for segment in segments:
        if segment.words:
            for w in segment.words:
                clean_word = w.word.strip().lower().strip(".,!?;:\"'()-")
                all_words.append({
                    "word": clean_word,
                    "start": round(w.start, 3),
                    "end": round(w.end, 3),
                    "probability": round(w.probability, 3)
                })
                
                # Exact match (highest priority)
                if clean_word == target_lower:
                    score = w.probability + 2.0
                    candidates.append((score, w, clean_word))
                    continue
                
                # Similar match — require at least 50% character similarity
                sim = word_similarity(clean_word, target_lower)
                if sim >= 0.5:
                    score = w.probability + sim
                    candidates.append((score, w, clean_word))
    
    # Sort candidates by score (highest first)
    candidates.sort(key=lambda x: x[0], reverse=True)
    
    # Energy verification: reject candidates in silent regions
    # This prevents selecting phantom words from noise at audio boundaries
    if candidates:
        peak_energy = get_peak_energy(wav_path)
        energy_threshold = peak_energy * 0.05  # 5% of peak = minimum for speech
        
        best_match = None
        for score, w, cw in candidates:
            seg_energy = get_rms_energy(wav_path, w.start, w.end)
            if seg_energy >= energy_threshold:
                best_match = w
                break
            # else: skip this candidate — it's in a silent/noise region
        
        if best_match is None:
            # All candidates failed energy check — use the one with highest energy
            # (better than returning nothing)
            energies = [(get_rms_energy(wav_path, w.start, w.end), w) for _, w, _ in candidates]
            energies.sort(key=lambda x: x[0], reverse=True)
            if energies[0][0] > 0:
                best_match = energies[0][1]
    else:
        best_match = None
    
    if best_match:
        # Dynamic padding based on word duration — adapts to short and long words
        word_dur = best_match.end - best_match.start
        before_pad = min(0.6, max(0.15, word_dur * 0.15))  # 15% of word, 150ms–600ms
        after_pad  = min(0.6, max(0.30, word_dur * 0.25))  # 25% of word, 300ms–600ms
        start = max(0, best_match.start - before_pad)
        end = best_match.end + after_pad
        
        return {
            "found": True,
            "start": round(start, 3),
            "end": round(end, 3),
            "word": best_match.word.strip(),
            "confidence": round(best_match.probability, 3),
            "all_words": all_words
        }
    else:
        return {
            "found": False,
            "error": f"Word '{target_word}' not found in audio",
            "all_words": all_words
        }


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(json.dumps({"found": False, "error": "Usage: python align.py <wav_file> <target_word> [--hint]"}))
        sys.exit(1)
    
    wav_file = sys.argv[1]
    target_word = sys.argv[2]
    use_hint = "--hint" in sys.argv
    
    if not os.path.exists(wav_file):
        print(json.dumps({"found": False, "error": f"File not found: {wav_file}"}))
        sys.exit(1)
    
    try:
        result = find_word_in_audio(wav_file, target_word, use_hint)
        print(json.dumps(result))
    except Exception as e:
        print(json.dumps({"found": False, "error": str(e)}))
        sys.exit(1)
