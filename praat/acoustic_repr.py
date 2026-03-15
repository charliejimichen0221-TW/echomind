"""
EchoMind Acoustic Representation Module

Transforms pronunciation analysis results into quantified acoustic representations
("聲音表徵") that capture a learner's sound impression of target words.

The representation consists of 6 dimensions:
1. Spectral Fidelity  — How close the sound "shape" is to the reference (MFCC-DTW)
2. Articulatory Accuracy — Mouth/tongue position accuracy (Formant F1/F2)
3. Temporal Control — Speed and rhythm accuracy (Duration ratio)
4. Prosodic Pattern — Intonation and stress pattern (Pitch contour)
5. Character Recognition — How intelligible the pronunciation is (wav2vec2)
6. Energy Dynamics — Volume/emphasis pattern (Intensity correlation)

Usage:
    python acoustic_repr.py <pronunciation_history.json> [--word <word>] [--output <output.json>]

Output: JSON with per-word acoustic representations and sound impression scores.
"""

import sys
import json
import os
import math
from collections import defaultdict

# Fix Windows encoding
if sys.platform == 'win32':
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')


def sigmoid(x: float, center: float = 0.5, steepness: float = 10.0) -> float:
    """Smooth sigmoid mapping to [0, 1]."""
    return 1.0 / (1.0 + math.exp(-steepness * (x - center)))


def compute_representation(records: list) -> dict:
    """
    Compute the acoustic representation for a set of practice records (single word).
    Returns a multi-dimensional acoustic profile.
    """
    if not records:
        return None

    word = records[0].get("word", "unknown")
    n = len(records)

    # ── Collect raw dimension values ──
    mfcc_scores = [r["mfccScore"] for r in records if r.get("mfccScore") is not None]
    f1_sims = [r["f1Similarity"] for r in records if r.get("f1Similarity") is not None]
    f2_sims = [r["f2Similarity"] for r in records if r.get("f2Similarity") is not None]
    dur_ratios = [r["durationRatio"] for r in records if r.get("durationRatio") is not None]
    pitch_matches = [r["pitchMatch"] for r in records if r.get("pitchMatch") is not None]
    intensity_matches = [r["intensityMatch"] for r in records if r.get("intensityMatch") is not None]
    overall_scores = [r["overall"] for r in records if r.get("overall") is not None]
    similarity_scores = [r["similarity"] for r in records if r.get("similarity") is not None]

    # ═══════════════════════════════════════════════════════════════
    # ENHANCED STATISTICAL HELPERS (high discriminability)
    # ═══════════════════════════════════════════════════════════════

    def safe_mean(arr):
        return sum(arr) / len(arr) if arr else 0

    def safe_median(arr):
        """Robust central tendency — not affected by outliers."""
        if not arr:
            return 0
        s = sorted(arr)
        n = len(s)
        if n % 2 == 1:
            return s[n // 2]
        return (s[n // 2 - 1] + s[n // 2]) / 2

    def safe_std(arr):
        if len(arr) < 2:
            return 0
        m = safe_mean(arr)
        return (sum((x - m) ** 2 for x in arr) / (len(arr) - 1)) ** 0.5

    def percentile(arr, p):
        """Calculate the p-th percentile (0-100)."""
        if not arr:
            return 0
        s = sorted(arr)
        k = (len(s) - 1) * p / 100
        f = int(k)
        c = f + 1 if f + 1 < len(s) else f
        d = k - f
        return s[f] + d * (s[c] - s[f])

    def iqr_filter(arr):
        """Remove outliers using IQR method (1.5×IQR rule)."""
        if len(arr) < 4:
            return arr
        q1 = percentile(arr, 25)
        q3 = percentile(arr, 75)
        iqr = q3 - q1
        if iqr < 0.001:  # All values nearly identical
            return arr
        lower = q1 - 1.5 * iqr
        upper = q3 + 1.5 * iqr
        return [x for x in arr if lower <= x <= upper]

    def ema(arr, alpha=0.3):
        """Exponential Moving Average — recent values weighted more heavily.
        alpha=0.3 means last value has 30% weight, previous 21%, etc.
        Higher alpha = more recency bias."""
        if not arr:
            return 0
        result = arr[0]
        for x in arr[1:]:
            result = alpha * x + (1 - alpha) * result
        return result

    def safe_latest(arr, k=5):
        """Weighted average of last k values — more recent = more weight.
        Uses linearly increasing weights [1, 2, 3, 4, 5] for k=5."""
        if not arr:
            return 0
        recent = arr[-k:]
        weights = list(range(1, len(recent) + 1))
        total_weight = sum(weights)
        return sum(v * w for v, w in zip(recent, weights)) / total_weight

    def trend(arr):
        """Linear regression slope — captures the DIRECTION of change over time.
        More robust than comparing first3 vs last3 because it uses ALL data points.
        Returns the average score change per attempt."""
        if len(arr) < 4:
            return 0
        n = len(arr)
        x_mean = (n - 1) / 2  # mean of [0, 1, ..., n-1]
        y_mean = safe_mean(arr)
        numerator = sum((i - x_mean) * (arr[i] - y_mean) for i in range(n))
        denominator = sum((i - x_mean) ** 2 for i in range(n))
        if denominator == 0:
            return 0
        slope = numerator / denominator
        # Scale: multiply by n to show total change over all attempts
        return slope * n

    def consistency(arr):
        """How consistent is the learner? 0 = wildly variable, 100 = rock steady.
        Uses coefficient of variation (CV) with IQR-filtered data."""
        if len(arr) < 3:
            return 100  # Not enough data to judge
        filtered = iqr_filter(arr)
        if not filtered:
            return 0
        m = safe_mean(filtered)
        if m < 1:
            return 0
        cv = safe_std(filtered) / m
        # Map CV to 0-100: CV=0 → 100, CV≥0.5 → 0
        return max(0, min(100, round(100 * (1 - cv * 2))))

    # ── Blended score: EMA 50% + weighted latest 30% + median 20% ──
    def blended_score(arr):
        """Combines multiple estimators for a robust, discriminating score."""
        if not arr:
            return 0
        e = ema(arr, alpha=0.3)
        l = safe_latest(arr, k=5)
        m = safe_median(arr)
        return e * 0.5 + l * 0.3 + m * 0.2

    # ═══════════════════════════════════════════
    # 1. Spectral Fidelity (from MFCC-DTW)
    #    "Does this sound like the word?"
    # ═══════════════════════════════════════════
    spectral = {
        "name": "Spectral Fidelity",
        "description": "Overall sound shape similarity — does your pronunciation sound like the target word?",
        "mean": round(safe_mean(iqr_filter(mfcc_scores)), 1),
        "median": round(safe_median(mfcc_scores), 1),
        "ema": round(ema(mfcc_scores), 1),
        "latest": round(safe_latest(mfcc_scores), 1),
        "best": round(max(mfcc_scores), 1) if mfcc_scores else 0,
        "p25": round(percentile(mfcc_scores, 25), 1),
        "p75": round(percentile(mfcc_scores, 75), 1),
        "std": round(safe_std(iqr_filter(mfcc_scores)), 1),
        "consistency": consistency(mfcc_scores),
        "trend": round(trend(mfcc_scores), 1),
        "score": round(blended_score(mfcc_scores), 0),
        "attempts": len(mfcc_scores),
    }

    # ═══════════════════════════════════════════
    # 2. Articulatory Accuracy (from Formant F1/F2)
    #    "Is your mouth/tongue in the right position?"
    # ═══════════════════════════════════════════
    formant_scores = [(f1 + f2) / 2 for f1, f2 in zip(f1_sims, f2_sims)] if f1_sims and f2_sims else []
    articulatory = {
        "name": "Articulatory Accuracy",
        "description": "Mouth and tongue position accuracy — are your vowels correct?",
        "f1_mean": round(safe_mean(iqr_filter(f1_sims)), 1),
        "f2_mean": round(safe_mean(iqr_filter(f2_sims)), 1),
        "mean": round(safe_mean(iqr_filter(formant_scores)), 1),
        "median": round(safe_median(formant_scores), 1),
        "ema": round(ema(formant_scores), 1),
        "latest": round(safe_latest(formant_scores), 1),
        "best": round(max(formant_scores), 1) if formant_scores else 0,
        "p25": round(percentile(formant_scores, 25), 1),
        "p75": round(percentile(formant_scores, 75), 1),
        "std": round(safe_std(iqr_filter(formant_scores)), 1),
        "consistency": consistency(formant_scores),
        "trend": round(trend(formant_scores), 1),
        "score": round(blended_score(formant_scores), 0),
        "attempts": len(formant_scores),
        "detail": {
            "f1_issue": "mouth_opening" if safe_median(f1_sims) < 50 else "ok",
            "f2_issue": "tongue_position" if safe_median(f2_sims) < 50 else "ok",
        }
    }

    # ═══════════════════════════════════════════
    # 3. Temporal Control (from Duration Ratio)
    #    "Is your speaking speed appropriate?"
    # ═══════════════════════════════════════════
    # Score: 100 for ratio 0.7-1.5, decreasing outside
    def dur_to_score(ratio):
        if 0.7 <= ratio <= 1.5:
            return 100
        elif ratio > 1.5:
            return max(0, 100 - (ratio - 1.5) * 30)
        else:
            return max(0, 100 - (0.7 - ratio) * 150)

    dur_scores = [dur_to_score(r) for r in dur_ratios]
    # Use IQR-filtered median for tendency — robust against outlier durations
    filtered_ratios = iqr_filter(dur_ratios)
    median_ratio = safe_median(filtered_ratios) if filtered_ratios else safe_median(dur_ratios)
    temporal = {
        "name": "Temporal Control",
        "description": "Speaking speed accuracy — not too fast, not too slow",
        "mean_ratio": round(safe_mean(iqr_filter(dur_ratios)), 2),
        "median_ratio": round(median_ratio, 2),
        "latest_ratio": round(safe_latest(dur_ratios), 2),
        "mean": round(safe_mean(iqr_filter(dur_scores)), 1),
        "median": round(safe_median(dur_scores), 1),
        "ema": round(ema(dur_scores), 1),
        "latest": round(safe_latest(dur_scores), 1),
        "best": round(max(dur_scores), 1) if dur_scores else 0,
        "p25": round(percentile(dur_scores, 25), 1),
        "p75": round(percentile(dur_scores, 75), 1),
        "std": round(safe_std(iqr_filter(dur_scores)), 1),
        "consistency": consistency(dur_scores),
        "trend": round(trend(dur_scores), 1),
        "score": round(blended_score(dur_scores), 0),
        "attempts": len(dur_scores),
        "tendency": "too_slow" if median_ratio > 1.5 else "too_fast" if median_ratio < 0.7 else "balanced",
    }

    # ═══════════════════════════════════════════
    # 4. Prosodic Pattern (from Pitch correlation)
    #    "Is your intonation/stress pattern correct?"
    # ═══════════════════════════════════════════
    pitch_scores = [max(0, p * 100) for p in pitch_matches]
    prosodic = {
        "name": "Prosodic Pattern",
        "description": "Intonation and stress pattern — does your melody match?",
        "mean_correlation": round(safe_mean(pitch_matches), 3),
        "median_correlation": round(safe_median(pitch_matches), 3),
        "mean": round(safe_mean(iqr_filter(pitch_scores)), 1),
        "median": round(safe_median(pitch_scores), 1),
        "ema": round(ema(pitch_scores), 1),
        "latest": round(safe_latest(pitch_scores), 1),
        "best": round(max(pitch_scores), 1) if pitch_scores else 0,
        "p25": round(percentile(pitch_scores, 25), 1),
        "p75": round(percentile(pitch_scores, 75), 1),
        "std": round(safe_std(iqr_filter(pitch_scores)), 1),
        "consistency": consistency(pitch_scores),
        "trend": round(trend(pitch_scores), 1),
        "score": round(blended_score(pitch_scores), 0),
        "attempts": len(pitch_scores),
    }

    # ═══════════════════════════════════════════
    # 5. Voice Production Quality (from individual analysis)
    #    "How clear and stable is your voice?"
    # ═══════════════════════════════════════════
    voice_quals = [r["voiceQuality"] for r in records if r.get("voiceQuality") is not None]
    vowel_clars = [r["vowelClarity"] for r in records if r.get("vowelClarity") is not None]
    fluencies = [r["fluency"] for r in records if r.get("fluency") is not None]
    # Combine 3 sub-scores into a single voice series for unified statistics
    voice_combined = [(vq + vc + fl) / 3 for vq, vc, fl in zip(voice_quals, vowel_clars, fluencies)]
    voice_production = {
        "name": "Voice Production",
        "description": "Voice quality, vowel clarity, and fluency",
        "voice_quality_mean": round(safe_mean(iqr_filter(voice_quals)), 1),
        "vowel_clarity_mean": round(safe_mean(iqr_filter(vowel_clars)), 1),
        "fluency_mean": round(safe_mean(iqr_filter(fluencies)), 1),
        "mean": round(safe_mean(iqr_filter(voice_combined)), 1) if voice_combined else 0,
        "median": round(safe_median(voice_combined), 1) if voice_combined else 0,
        "ema": round(ema(voice_combined), 1) if voice_combined else 0,
        "latest": round(safe_latest(voice_combined), 1) if voice_combined else 0,
        "p25": round(percentile(voice_combined, 25), 1) if voice_combined else 0,
        "p75": round(percentile(voice_combined, 75), 1) if voice_combined else 0,
        "consistency": consistency(voice_combined) if voice_combined else 0,
        "score": round(blended_score(voice_combined), 0) if voice_combined else 0,
        "trend": round(trend(voice_combined), 1) if voice_combined else 0,
        "attempts": len(voice_quals),
    }

    # ═══════════════════════════════════════════
    # 6. Energy Dynamics (from Intensity correlation)
    #    "Is your emphasis pattern correct?"
    # ═══════════════════════════════════════════
    int_scores = [max(0, i * 100) for i in intensity_matches]
    energy = {
        "name": "Energy Dynamics",
        "description": "Volume and emphasis pattern — are you stressing the right syllables?",
        "mean_correlation": round(safe_mean(intensity_matches), 3),
        "median_correlation": round(safe_median(intensity_matches), 3),
        "mean": round(safe_mean(iqr_filter(int_scores)), 1),
        "median": round(safe_median(int_scores), 1),
        "ema": round(ema(int_scores), 1),
        "latest": round(safe_latest(int_scores), 1),
        "best": round(max(int_scores), 1) if int_scores else 0,
        "p25": round(percentile(int_scores, 25), 1),
        "p75": round(percentile(int_scores, 75), 1),
        "std": round(safe_std(iqr_filter(int_scores)), 1),
        "consistency": consistency(int_scores),
        "trend": round(trend(int_scores), 1),
        "score": round(blended_score(int_scores), 0),
        "attempts": len(int_scores),
    }

    # ═══════════════════════════════════════════
    # Sound Impression Score (聲音印象分數)
    # Weighted composite of all dimensions
    # ═══════════════════════════════════════════
    weights = {
        "spectral": 0.30,        # Core sound similarity
        "articulatory": 0.25,    # Vowel/consonant accuracy
        "temporal": 0.10,        # Speed control
        "prosodic": 0.05,        # Intonation (low: AI vs human)
        "voice_production": 0.25, # Individual voice quality
        "energy": 0.05,          # Emphasis (low: mic varies)
    }

    impression_score = round(
        spectral["score"] * weights["spectral"] +
        articulatory["score"] * weights["articulatory"] +
        temporal["score"] * weights["temporal"] +
        prosodic["score"] * weights["prosodic"] +
        voice_production["score"] * weights["voice_production"] +
        energy["score"] * weights["energy"]
    )

    # ── Mastery assessment ──
    if impression_score >= 80:
        mastery = "mastered"
        mastery_label = "Mastered — excellent sound impression!"
    elif impression_score >= 65:
        mastery = "proficient"
        mastery_label = "Proficient — good overall, minor areas to improve"
    elif impression_score >= 50:
        mastery = "developing"
        mastery_label = "Developing — recognizable but needs practice"
    elif impression_score >= 35:
        mastery = "beginning"
        mastery_label = "Beginning — significant areas need work"
    else:
        mastery = "novice"
        mastery_label = "Novice — keep practicing!"

    # ── Identify strengths and weaknesses ──
    dim_scores = {
        "Spectral Fidelity": spectral["score"],
        "Articulatory Accuracy": articulatory["score"],
        "Temporal Control": temporal["score"],
        "Voice Production": voice_production["score"],
    }
    sorted_dims = sorted(dim_scores.items(), key=lambda x: x[1], reverse=True)
    strengths = [d for d, s in sorted_dims if s >= 65][:2]
    weaknesses = [d for d, s in sorted_dims if s < 50][:2]

    # ── Overall trend ──
    overall_trend = trend(overall_scores) if overall_scores else 0

    return {
        "word": word,
        "total_attempts": n,
        "first_attempt": records[0].get("date"),
        "last_attempt": records[-1].get("date"),
        "sound_impression_score": max(0, min(100, impression_score)),
        "mastery_level": mastery,
        "mastery_label": mastery_label,
        "overall_trend": round(overall_trend, 1),
        "strengths": strengths,
        "weaknesses": weaknesses,
        "dimensions": {
            "spectral_fidelity": spectral,
            "articulatory_accuracy": articulatory,
            "temporal_control": temporal,
            "prosodic_pattern": prosodic,
            "voice_production": voice_production,
            "energy_dynamics": energy,
        },
        "weights": weights,
        "history_summary": {
            "overall_mean": round(safe_mean(overall_scores), 1),
            "overall_latest": round(safe_latest(overall_scores), 1),
            "overall_best": round(max(overall_scores)) if overall_scores else 0,
            "similarity_mean": round(safe_mean(similarity_scores), 1),
            "similarity_latest": round(safe_latest(similarity_scores), 1),
            "similarity_best": round(max(similarity_scores)) if similarity_scores else 0,
        },
    }


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: python acoustic_repr.py <pronunciation_history.json> [--word <word>] [--output <file.json>]"}))
        sys.exit(1)

    history_path = sys.argv[1]
    target_word = None
    output_path = None

    if "--word" in sys.argv:
        idx = sys.argv.index("--word")
        if idx + 1 < len(sys.argv):
            target_word = sys.argv[idx + 1].lower()

    if "--output" in sys.argv:
        idx = sys.argv.index("--output")
        if idx + 1 < len(sys.argv):
            output_path = sys.argv[idx + 1]

    if not os.path.exists(history_path):
        print(json.dumps({"error": f"File not found: {history_path}"}))
        sys.exit(1)

    with open(history_path, 'r', encoding='utf-8') as f:
        records = json.load(f)

    # Group by word
    by_word = defaultdict(list)
    for r in records:
        if r.get("matched"):
            by_word[r["word"].lower()].append(r)

    # Sort each word's records by timestamp
    for w in by_word:
        by_word[w].sort(key=lambda r: r.get("timestamp", 0))

    if target_word:
        if target_word not in by_word:
            print(json.dumps({"error": f"No records for word: {target_word}"}))
            sys.exit(1)
        result = {
            "type": "acoustic_representation",
            "generated_at": __import__('datetime').datetime.now().isoformat(),
            "words": {target_word: compute_representation(by_word[target_word])}
        }
    else:
        result = {
            "type": "acoustic_representation",
            "generated_at": __import__('datetime').datetime.now().isoformat(),
            "total_words": len(by_word),
            "total_attempts": len(records),
            "words": {}
        }
        for w, recs in sorted(by_word.items()):
            result["words"][w] = compute_representation(recs)

    # Output
    if output_path:
        with open(output_path, 'w', encoding='utf-8') as f:
            json.dump(result, f, indent=2, ensure_ascii=False)
        print(f"[acoustic_repr] Results saved to {output_path}", file=sys.stderr)

    # Summary to stdout
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
