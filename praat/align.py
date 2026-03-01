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
    best_match = None
    best_score = 0
    all_words = []
    
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
                    if score > best_score:
                        best_score = score
                        best_match = w
                    continue
                
                # Similar match — require at least 50% character similarity
                sim = word_similarity(clean_word, target_lower)
                if sim >= 0.5:
                    score = w.probability + sim
                    if score > best_score:
                        best_score = score
                        best_match = w
    
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
