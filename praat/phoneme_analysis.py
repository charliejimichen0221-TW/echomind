"""
EchoMind Phoneme-level Pronunciation Analysis using wav2vec 2.0

Uses facebook/wav2vec2-base-960h for character-level speech recognition,
then maps characters to ARPAbet phonemes using a pronunciation dictionary.
Outputs per-frame character probabilities and phoneme-level analysis.

Usage:
    python phoneme_analysis.py <wav_file> <target_word> [--output <output.json>]

Output: JSON with character probabilities, phoneme alignment, and accuracy scores.
"""

import sys
import json
import os
import warnings
import wave
import struct

warnings.filterwarnings("ignore")
os.environ["KMP_DUPLICATE_LIB_OK"] = "TRUE"

# Fix Windows encoding: force UTF-8 for stdout/stderr (cp950 can't handle IPA chars)
if sys.platform == 'win32':
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')

_processor = None
_model = None
_SAMPLE_RATE = 16000


def get_model():
    """Load wav2vec2 model (cached globally)."""
    global _processor, _model
    if _processor is None:
        import torch
        from transformers import Wav2Vec2ForCTC, Wav2Vec2Processor

        model_name = "facebook/wav2vec2-base-960h"
        print(f"[wav2vec2] Loading model: {model_name}...", file=sys.stderr)
        _processor = Wav2Vec2Processor.from_pretrained(model_name)
        _model = Wav2Vec2ForCTC.from_pretrained(model_name)
        _model.eval()
        print(f"[wav2vec2] Model loaded successfully.", file=sys.stderr)
    return _processor, _model


def load_wav_16k(wav_path: str):
    """Load WAV file and resample to 16kHz if needed."""
    import numpy as np

    with wave.open(wav_path, 'rb') as w:
        rate = w.getframerate()
        n = w.getnframes()
        channels = w.getnchannels()
        frames = w.readframes(n)

    samples = struct.unpack(f'<{len(frames)//2}h', frames)
    if channels == 2:
        samples = samples[::2]

    audio = np.array(samples, dtype=np.float32) / 32768.0

    if rate != _SAMPLE_RATE:
        from scipy.signal import resample
        new_len = int(len(audio) * _SAMPLE_RATE / rate)
        audio = resample(audio, new_len).astype(np.float32)

    return audio


# ── Per-word pronunciation coaching dictionary ──
# Each word includes: expected chars, phonemes, IPA, syllable breakdown,
# AND word-specific coaching data: focus sounds, stress position, common errors, tips.
WORD_EXPECTED = {
    "hypothesis": {
        "chars": "HYPOTHESIS",
        "phonemes": ["HH", "AY", "P", "AA", "TH", "AH", "S", "IH", "S"],
        "ipa": "haɪˈpɒθəsɪs",
        "syllables": ["hy", "POTH", "e", "sis"],
        "stress_syllable": 2,
        "focus_sounds": ["TH", "AY"],
        "common_errors": ["TH_as_S", "TH_as_T", "stress_wrong"],
        "tip": "The 'th' in the middle needs your tongue between your teeth. Stress falls on the SECOND syllable: hy-POTH-e-sis.",
    },
    "analyze": {
        "chars": "ANALYZE",
        "phonemes": ["AE", "N", "AH", "L", "AY", "Z"],
        "ipa": "ˈænəlaɪz",
        "syllables": ["AN", "a", "lyze"],
        "stress_syllable": 1,
        "focus_sounds": ["AE", "AY", "Z"],
        "common_errors": ["vowel_shift", "Z_as_S"],
        "tip": "Stress the FIRST syllable: AN-a-lyze. The 'a' is like in 'cat', and end with a buzzing 'z', not 's'.",
    },
    "empirical": {
        "chars": "EMPIRICAL",
        "phonemes": ["EH", "M", "P", "IH", "R", "IH", "K", "AH", "L"],
        "ipa": "ɪmˈpɪrɪkəl",
        "syllables": ["em", "PIR", "i", "cal"],
        "stress_syllable": 2,
        "focus_sounds": ["IH", "R"],
        "common_errors": ["R_unclear", "vowel_shift"],
        "tip": "Stress the SECOND syllable: em-PIR-i-cal. The 'r' in 'pir' should be a clear American 'r' with tongue curled back.",
    },
    "synthesize": {
        "chars": "SYNTHESIZE",
        "phonemes": ["S", "IH", "N", "TH", "AH", "S", "AY", "Z"],
        "ipa": "ˈsɪnθəsaɪz",
        "syllables": ["SIN", "the", "size"],
        "stress_syllable": 1,
        "focus_sounds": ["TH", "AY", "Z"],
        "common_errors": ["TH_as_S", "Z_as_S"],
        "tip": "Stress the FIRST syllable: SIN-the-size. The 'th' needs tongue between teeth, and end with 'z' not 's'.",
    },
    "phenomena": {
        "chars": "PHENOMENA",
        "phonemes": ["F", "AH", "N", "AA", "M", "AH", "N", "AH"],
        "ipa": "fəˈnɒmɪnə",
        "syllables": ["fe", "NOM", "e", "na"],
        "stress_syllable": 2,
        "focus_sounds": ["F", "AA"],
        "common_errors": ["F_as_P", "stress_wrong"],
        "tip": "Starts with 'f' not 'p' — upper teeth on lower lip. Stress: fe-NOM-e-na.",
    },
    "paradigm": {
        "chars": "PARADIGM",
        "phonemes": ["P", "AE", "R", "AH", "D", "AY", "M"],
        "ipa": "ˈpærədaɪm",
        "syllables": ["PAR", "a", "dime"],
        "stress_syllable": 1,
        "focus_sounds": ["AE", "AY"],
        "common_errors": ["silent_G", "vowel_shift"],
        "tip": "The 'g' is SILENT — say PAR-a-dime, not 'para-dig-m'. Rhymes with 'dime'.",
    },
    "algorithm": {
        "chars": "ALGORITHM",
        "phonemes": ["AE", "L", "G", "AH", "R", "IH", "DH", "AH", "M"],
        "ipa": "ˈælɡərɪðəm",
        "syllables": ["AL", "go", "ri", "thm"],
        "stress_syllable": 1,
        "focus_sounds": ["TH", "AE"],
        "common_errors": ["TH_as_T", "R_unclear"],
        "tip": "Stress the FIRST syllable: AL-go-ri-thm. The ending 'thm' is tricky — tongue between teeth then close lips for 'm'.",
    },
    "cognitive": {
        "chars": "COGNITIVE",
        "phonemes": ["K", "AA", "G", "N", "AH", "T", "IH", "V"],
        "ipa": "ˈkɒɡnɪtɪv",
        "syllables": ["COG", "ni", "tive"],
        "stress_syllable": 1,
        "focus_sounds": ["AA", "IH", "V"],
        "common_errors": ["V_as_W", "vowel_shift"],
        "tip": "Stress: COG-ni-tive. End with 'v' — feel your upper teeth on your lower lip, not a 'w' sound.",
    },
    "significant": {
        "chars": "SIGNIFICANT",
        "phonemes": ["S", "IH", "G", "N", "IH", "F", "IH", "K", "AH", "N", "T"],
        "ipa": "sɪɡˈnɪfɪkənt",
        "syllables": ["sig", "NIF", "i", "cant"],
        "stress_syllable": 2,
        "focus_sounds": ["IH", "F"],
        "common_errors": ["vowel_shift", "stress_wrong"],
        "tip": "Stress the SECOND syllable: sig-NIF-i-cant. Has three short 'i' sounds — keep them quick and crisp.",
    },
    "vocabulary": {
        "chars": "VOCABULARY",
        "phonemes": ["V", "OW", "K", "AE", "B", "Y", "AH", "L", "EH", "R", "IY"],
        "ipa": "voʊˈkæbjʊlɛɹi",
        "syllables": ["vo", "CAB", "u", "lar", "y"],
        "stress_syllable": 2,
        "focus_sounds": ["V", "AE", "B"],
        "common_errors": ["V_as_W", "vowel_shift"],
        "tip": "Stress: vo-CAB-u-lar-y. Start with 'v' (teeth on lip, not 'w'). The 'a' in 'cab' is like 'cat'.",
    },
    "evaluate": {
        "chars": "EVALUATE",
        "phonemes": ["IH", "V", "AE", "L", "Y", "UW", "EY", "T"],
        "ipa": "ɪˈvæljueɪt",
        "syllables": ["e", "VAL", "u", "ate"],
        "stress_syllable": 2,
        "focus_sounds": ["V", "AE", "EY"],
        "common_errors": ["V_as_W", "vowel_shift"],
        "tip": "Stress: e-VAL-u-ate. 'v' needs teeth on lip. The 'al' has an open 'a' like 'valley'.",
    },
    "appreciate": {
        "chars": "APPRECIATE",
        "phonemes": ["AH", "P", "R", "IY", "SH", "IY", "EY", "T"],
        "ipa": "əˈpriːʃieɪt",
        "syllables": ["a", "PRE", "ci", "ate"],
        "stress_syllable": 2,
        "focus_sounds": ["SH", "IY"],
        "common_errors": ["SH_as_S", "R_unclear"],
        "tip": "Stress: a-PRE-ci-ate. The 'ci' makes a 'sh' sound (like 'she'), not an 's' sound.",
    },
    "consequence": {
        "chars": "CONSEQUENCE",
        "phonemes": ["K", "AA", "N", "S", "AH", "K", "W", "EH", "N", "S"],
        "ipa": "ˈkɒnsɪkwəns",
        "syllables": ["CON", "se", "quence"],
        "stress_syllable": 1,
        "focus_sounds": ["K", "W"],
        "common_errors": ["vowel_shift"],
        "tip": "Stress: CON-se-quence. The 'qu' is a 'kw' blend — say both sounds quickly together.",
    },
    "collaborate": {
        "chars": "COLLABORATE",
        "phonemes": ["K", "AH", "L", "AE", "B", "AH", "R", "EY", "T"],
        "ipa": "kəˈlæbəreɪt",
        "syllables": ["co", "LAB", "o", "rate"],
        "stress_syllable": 2,
        "focus_sounds": ["AE", "R", "EY"],
        "common_errors": ["R_unclear", "vowel_shift"],
        "tip": "Stress: co-LAB-o-rate. The 'a' in 'lab' is open like 'cat'. Clear 'r' in 'rate'.",
    },
    "demonstrate": {
        "chars": "DEMONSTRATE",
        "phonemes": ["D", "EH", "M", "AH", "N", "S", "T", "R", "EY", "T"],
        "ipa": "ˈdemənstreɪt",
        "syllables": ["DEM", "on", "strate"],
        "stress_syllable": 1,
        "focus_sounds": ["STR", "EY"],
        "common_errors": ["consonant_cluster"],
        "tip": "Stress: DEM-on-strate. The 'str' cluster needs all three sounds — don't drop the 't'.",
    },
    "interpretation": {
        "chars": "INTERPRETATION",
        "phonemes": ["IH", "N", "T", "ER", "P", "R", "AH", "T", "EY", "SH", "AH", "N"],
        "ipa": "ɪnˌtɜːprɪˈteɪʃən",
        "syllables": ["in", "ter", "pre", "TA", "tion"],
        "stress_syllable": 4,
        "focus_sounds": ["SH", "EY", "R"],
        "common_errors": ["SH_as_S", "stress_wrong"],
        "tip": "Stress the FOURTH syllable: in-ter-pre-TA-tion. The 'tion' = 'shun', not 'tee-on'.",
    },
    "synthesis": {
        "chars": "SYNTHESIS",
        "phonemes": ["S", "IH", "N", "TH", "AH", "S", "IH", "S"],
        "ipa": "ˈsɪnθəsɪs",
        "syllables": ["SIN", "the", "sis"],
        "stress_syllable": 1,
        "focus_sounds": ["TH", "IH"],
        "common_errors": ["TH_as_S"],
        "tip": "Stress: SIN-the-sis. The 'th' needs tongue between teeth. Different from 'synthesize' — this one ends with 'sis'.",
    },
    "theory": {
        "chars": "THEORY",
        "phonemes": ["TH", "IH", "R", "IY"],
        "ipa": "ˈθɪəri",
        "syllables": ["THEE", "o", "ry"],
        "stress_syllable": 1,
        "focus_sounds": ["TH", "IH"],
        "common_errors": ["TH_as_T", "TH_as_S"],
        "tip": "Starts with 'th' — tongue between teeth with airflow, not a hard 't'. Stress: THEE-o-ry.",
    },
    "variable": {
        "chars": "VARIABLE",
        "phonemes": ["V", "EH", "R", "IY", "AH", "B", "AH", "L"],
        "ipa": "ˈvɛriəbəl",
        "syllables": ["VAR", "i", "a", "ble"],
        "stress_syllable": 1,
        "focus_sounds": ["V", "R"],
        "common_errors": ["V_as_W", "R_unclear"],
        "tip": "Start with 'v' (teeth on lip). Stress: VAR-i-a-ble. The 'r' is a clear American 'r'.",
    },
    "qualitative": {
        "chars": "QUALITATIVE",
        "phonemes": ["K", "W", "AA", "L", "AH", "T", "EY", "T", "IH", "V"],
        "ipa": "ˈkwɒlɪtətɪv",
        "syllables": ["QUAL", "i", "ta", "tive"],
        "stress_syllable": 1,
        "focus_sounds": ["KW", "V"],
        "common_errors": ["V_as_W", "consonant_cluster"],
        "tip": "Starts with 'kw' blend. Stress: QUAL-i-ta-tive. End with 'v' not 'f'.",
    },
}


def analyze_phonemes(wav_path: str, target_word: str) -> dict:
    """Run wav2vec 2.0 analysis and return per-character probabilities."""
    import torch
    import numpy as np

    processor, model = get_model()
    audio = load_wav_16k(wav_path)

    # ── Model inference ──
    inputs = processor(audio, sampling_rate=_SAMPLE_RATE, return_tensors="pt", padding=True)
    with torch.no_grad():
        outputs = model(**inputs)
        logits = outputs.logits  # (1, time_frames, vocab_size=32)

    probs = torch.softmax(logits[0], dim=-1)  # (time_frames, 32)
    predicted_ids = torch.argmax(logits, dim=-1)[0]

    # ── Decode transcription ──
    transcription = processor.decode(predicted_ids).strip()

    # ── Build vocab mapping ──
    vocab = processor.tokenizer.get_vocab()
    id_to_token = {v: k for k, v in vocab.items()}

    num_frames = probs.shape[0]
    audio_duration = len(audio) / _SAMPLE_RATE
    frame_duration = audio_duration / num_frames

    # ── Extract character segments (merge consecutive same-char frames) ──
    char_segments = []
    current_char = None
    current_start = 0
    current_probs = []

    for frame_idx in range(num_frames):
        token_id = predicted_ids[frame_idx].item()
        token = id_to_token.get(token_id, "?")
        prob = probs[frame_idx][token_id].item()

        if token in ("<pad>", "<s>", "</s>"):
            if current_char is not None:
                char_segments.append({
                    "char": current_char,
                    "start": round(current_start * frame_duration, 3),
                    "end": round(frame_idx * frame_duration, 3),
                    "confidence": round(sum(current_probs) / len(current_probs), 4),
                    "frames": len(current_probs)
                })
                current_char = None
                current_probs = []
            continue

        if token != current_char:
            if current_char is not None:
                char_segments.append({
                    "char": current_char,
                    "start": round(current_start * frame_duration, 3),
                    "end": round(frame_idx * frame_duration, 3),
                    "confidence": round(sum(current_probs) / len(current_probs), 4),
                    "frames": len(current_probs)
                })
            current_char = token
            current_start = frame_idx
            current_probs = [prob]
        else:
            current_probs.append(prob)

    if current_char is not None:
        char_segments.append({
            "char": current_char,
            "start": round(current_start * frame_duration, 3),
            "end": round(num_frames * frame_duration, 3),
            "confidence": round(sum(current_probs) / len(current_probs), 4),
            "frames": len(current_probs)
        })

    # ── Per-frame top-5 probabilities (full detail) ──
    frame_probabilities = []
    for frame_idx in range(num_frames):
        frame_probs = probs[frame_idx]
        top5 = torch.topk(frame_probs, 5)

        top5_list = []
        for idx, p in zip(top5.indices.tolist(), top5.values.tolist()):
            token = id_to_token.get(idx, "?")
            if token in ("<pad>", "<s>", "</s>"):
                token = "_"  # blank/silence
            top5_list.append({"char": token, "prob": round(p, 4)})

        frame_probabilities.append({
            "time": round(frame_idx * frame_duration, 3),
            "top5": top5_list
        })

    # ── Character-level accuracy against expected word ──
    expected_info = WORD_EXPECTED.get(target_word.lower().strip())
    char_accuracy = None

    # If word not in dictionary, auto-generate from uppercase spelling
    if not expected_info:
        expected_info = {"chars": target_word.upper().strip()}

    if expected_info:
        expected_chars = expected_info["chars"]
        recognized_chars = "".join(seg["char"] for seg in char_segments if seg["char"] != "|")

        # Compute edit distance for character accuracy
        matches = 0
        for i, ec in enumerate(expected_chars):
            if i < len(recognized_chars) and recognized_chars[i] == ec:
                matches += 1

        # Also do a more forgiving alignment
        from difflib import SequenceMatcher
        matcher = SequenceMatcher(None, expected_chars, recognized_chars)
        similarity = matcher.ratio()

        # Per-character alignment
        alignment = []
        for tag, i1, i2, j1, j2 in matcher.get_opcodes():
            if tag == 'equal':
                for k in range(i2 - i1):
                    alignment.append({
                        "expected": expected_chars[i1 + k],
                        "recognized": recognized_chars[j1 + k],
                        "status": "correct"
                    })
            elif tag == 'replace':
                for k in range(max(i2 - i1, j2 - j1)):
                    exp_c = expected_chars[i1 + k] if (i1 + k) < i2 else "∅"
                    rec_c = recognized_chars[j1 + k] if (j1 + k) < j2 else "∅"
                    alignment.append({
                        "expected": exp_c,
                        "recognized": rec_c,
                        "status": "substitution"
                    })
            elif tag == 'delete':
                for k in range(i2 - i1):
                    alignment.append({
                        "expected": expected_chars[i1 + k],
                        "recognized": "∅",
                        "status": "deletion"
                    })
            elif tag == 'insert':
                for k in range(j2 - j1):
                    alignment.append({
                        "expected": "∅",
                        "recognized": recognized_chars[j1 + k],
                        "status": "insertion"
                    })

        char_accuracy = {
            "expected": expected_chars,
            "recognized": recognized_chars,
            "similarity": round(similarity * 100, 1),
            "alignment": alignment,
            "ipa": expected_info.get("ipa"),
            "phonemes_arpabet": expected_info.get("phonemes"),
            "syllables": expected_info.get("syllables"),
            "stress_syllable": expected_info.get("stress_syllable"),
            "focus_sounds": expected_info.get("focus_sounds"),
            "common_errors": expected_info.get("common_errors"),
            "tip": expected_info.get("tip"),
        }

    result = {
        "target_word": target_word,
        "recognized_text": transcription,
        "audio_duration": round(audio_duration, 3),
        "model": "wav2vec2-base-960h",
        "char_segments": char_segments,
        "phoneme_count": len(char_segments),
        "char_accuracy": char_accuracy,
        "word_tip": expected_info.get("tip") if expected_info else None,
        "syllable_breakdown": "-".join(expected_info.get("syllables", [])) if expected_info else None,
        "frame_count": num_frames,
        "frame_duration_ms": round(frame_duration * 1000, 2),
        "frame_probabilities": frame_probabilities,
    }

    return result


def main():
    if len(sys.argv) < 3:
        print(json.dumps({"error": "Usage: python phoneme_analysis.py <wav_file> <target_word> [--output <file.json>]"}))
        sys.exit(1)

    wav_path = sys.argv[1]
    target_word = sys.argv[2]

    output_path = None
    if "--output" in sys.argv:
        idx = sys.argv.index("--output")
        if idx + 1 < len(sys.argv):
            output_path = sys.argv[idx + 1]

    if not os.path.exists(wav_path):
        print(json.dumps({"error": f"File not found: {wav_path}"}))
        sys.exit(1)

    try:
        result = analyze_phonemes(wav_path, target_word)

        # Save full results (including frame_probabilities) to file
        if output_path:
            with open(output_path, 'w', encoding='utf-8') as f:
                json.dump(result, f, indent=2, ensure_ascii=False)
            print(f"[wav2vec2] Full results saved to {output_path}", file=sys.stderr)

        # For stdout: skip frame_probabilities (too large) for Node.js integration
        stdout_result = {k: v for k, v in result.items() if k != "frame_probabilities"}
        print(json.dumps(stdout_result, ensure_ascii=False))

    except Exception as e:
        import traceback
        traceback.print_exc(file=sys.stderr)
        print(json.dumps({"error": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
