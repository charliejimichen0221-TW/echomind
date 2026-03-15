"""
EchoMind Pronunciation Feedback Generator

Transforms wav2vec2 phoneme analysis + acoustic representation data into
actionable, human-readable pronunciation guidance.

Usage:
    python feedback_generator.py <phoneme_json> <history_json> <target_word>

Output (JSON):
{
    "word": "hypothesis",
    "feedback_lines": ["..."],         // Array of feedback strings for AI prompt
    "problem_sounds": [...],           // Specific sounds to work on
    "practice_tips": [...],            // Actionable tips
    "mastery_summary": "...",          // One-line mastery status
}
"""

import sys
import json
import os
from collections import defaultdict

if sys.platform == 'win32':
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')


# ── IPA pronunciation guides for common problem patterns ──
SOUND_GUIDES = {
    # Consonants
    "TH_as_S": {
        "problem": "Producing /s/ instead of /θ/ (th-fronting)",
        "tip": "Place your tongue between your teeth and blow air gently. The tip of your tongue should be visible.",
        "example": "Think of 'think' — tongue between teeth, NOT like 'sink'."
    },
    "TH_as_T": {
        "problem": "Producing /t/ instead of /θ/",
        "tip": "Don't tap your tongue on the roof — let it rest between your teeth with continuous airflow.",
        "example": "'Three' should feel breathy, NOT like 'tree'."
    },
    "V_as_W": {
        "problem": "Producing /w/ instead of /v/",
        "tip": "Your bottom lip should touch your upper teeth for /v/. /w/ uses only lip rounding.",
        "example": "'Very' — feel your teeth on your lip, NOT like 'wery'."
    },
    "R_unclear": {
        "problem": "Unclear /r/ sound",
        "tip": "Curl your tongue back without touching the roof of your mouth. Your tongue should float.",
        "example": "For 'right', your tongue curls back — it never touches anything."
    },
    "L_as_R": {
        "problem": "Confusing /l/ and /r/",
        "tip": "For /l/, your tongue tip touches the ridge behind your upper teeth. For /r/, your tongue curls back and doesn't touch.",
        "example": "'Light' (tongue touches) vs 'right' (tongue floats)."
    },
    "vowel_shift": {
        "problem": "Vowel sounds are shifted from the target",
        "tip": "Pay attention to mouth opening (wider = more open vowel like /a/) and tongue position (front = /i/, back = /u/).",
        "example": "For 'hypothesis': hy-POTH-e-sis — the stressed vowel /ɒ/ needs a rounded, open mouth."
    },
    "F2_low": {
        "problem": "Tongue position is consistently off (F2 too low)",
        "tip": "Your tongue may be too far back. Try pushing your tongue slightly forward for front vowels like /i/, /e/, /æ/.",
        "example": "Say 'see' and notice where your tongue is — it should be high and forward."
    },
    "too_fast": {
        "problem": "Speaking too quickly, syllables may be unclear",
        "tip": "Slow down and clearly pronounce each syllable. It's better to be slow and clear than fast and mumbled.",
        "example": "Break the word into syllables: hy - POTH - e - sis, then speed up gradually."
    },
    "too_slow": {
        "problem": "Speaking much slower than natural pace",
        "tip": "Try to connect syllables more smoothly. Don't pause between each syllable.",
        "example": "Instead of 'hy...poth...e...sis', aim for a flowing 'hy-POTH-e-sis'."
    },
}


def detect_problems(phoneme_data: dict, acoustic_data: dict, word: str) -> list:
    """Detect specific pronunciation problems from the analysis data."""
    problems = []
    word_lower = word.lower()

    # ── From wav2vec2 phoneme analysis ──
    if phoneme_data and phoneme_data.get("char_accuracy"):
        ca = phoneme_data["char_accuracy"]
        alignment = ca.get("alignment", [])
        expected = ca.get("expected", "")
        recognized = ca.get("recognized", "")

        # Detect specific sound substitutions
        for a in alignment:
            exp = a.get("expected", "")
            rec = a.get("recognized", "")
            status = a.get("status", "")

            if status == "substitution":
                # TH → S (th-fronting)
                if exp in ("T", "H") and rec == "S":
                    problems.append({"type": "TH_as_S", "position": exp, "severity": "high"})
                # TH → T
                elif exp == "T" and rec == "T" and "TH" in expected:
                    problems.append({"type": "TH_as_T", "position": exp, "severity": "medium"})
                # Generic vowel substitution
                elif exp in "AEIOU" and rec in "AEIOU" and exp != rec:
                    problems.append({"type": "vowel_shift", "position": f"{exp}→{rec}", "severity": "medium"})

            elif status == "deletion":
                problems.append({"type": "deletion", "position": exp, "severity": "medium",
                                 "detail": f"Missing sound '{exp}'"})

        # Low confidence characters
        if phoneme_data.get("char_segments"):
            for seg in phoneme_data["char_segments"]:
                if seg.get("confidence", 1.0) < 0.6 and seg["char"] not in ("|", "_"):
                    problems.append({"type": "low_confidence", "position": seg["char"],
                                     "severity": "low", "confidence": seg["confidence"],
                                     "detail": f"Unclear '{seg['char']}' (confidence: {seg['confidence']:.0%})"})

    # ── From acoustic representation ──
    if acoustic_data:
        dims = acoustic_data.get("dimensions", {})

        # F2 (tongue position) problems
        artic = dims.get("articulatory_accuracy", {})
        if artic.get("f2_mean", 100) < 40:
            problems.append({"type": "F2_low", "severity": "high",
                             "detail": f"Average F2 similarity only {artic['f2_mean']:.0f}%"})
        elif artic.get("detail", {}).get("f2_issue") == "tongue_position":
            problems.append({"type": "F2_low", "severity": "medium",
                             "detail": f"F2 (tongue position) needs work"})

        # Speed problems
        temporal = dims.get("temporal_control", {})
        tendency = temporal.get("tendency", "balanced")
        if tendency == "too_fast":
            problems.append({"type": "too_fast", "severity": "medium",
                             "detail": f"Average duration ratio: {temporal.get('mean_ratio', 0):.2f}x"})
        elif tendency == "too_slow" and temporal.get("mean_ratio", 1) > 2.5:
            problems.append({"type": "too_slow", "severity": "low",
                             "detail": f"Average duration ratio: {temporal.get('mean_ratio', 0):.2f}x"})

    # Deduplicate by type
    seen = set()
    unique = []
    for p in problems:
        if p["type"] not in seen:
            seen.add(p["type"])
            unique.append(p)

    return unique


def generate_feedback(word: str, phoneme_data: dict, acoustic_data: dict) -> dict:
    """Generate structured pronunciation feedback."""

    problems = detect_problems(phoneme_data, acoustic_data, word)

    # ── Build feedback lines (for AI prompt injection) ──
    feedback_lines = []

    # 1. Recognition summary
    if phoneme_data:
        recognized = phoneme_data.get("recognized_text", "")
        accuracy = phoneme_data.get("char_accuracy", {})
        similarity = accuracy.get("similarity", 0)
        expected = accuracy.get("expected", word.upper())

        feedback_lines.append(f"[PHONEME ANALYSIS] wav2vec2 heard: \"{recognized}\" (expected: \"{expected}\")")
        feedback_lines.append(f"Character-level similarity: {similarity}%")

        # Show alignment issues
        alignment = accuracy.get("alignment", [])
        issues = [a for a in alignment if a.get("status") != "correct"]
        if issues:
            issue_strs = []
            for a in issues[:5]:  # max 5
                if a["status"] == "substitution":
                    issue_strs.append(f"'{a['expected']}'→'{a['recognized']}'")
                elif a["status"] == "deletion":
                    issue_strs.append(f"'{a['expected']}' missing")
                elif a["status"] == "insertion":
                    issue_strs.append(f"extra '{a['recognized']}'")
            feedback_lines.append(f"Sound issues: {', '.join(issue_strs)}")

    # 2. Acoustic representation summary
    if acoustic_data:
        score = acoustic_data.get("sound_impression_score", 0)
        mastery = acoustic_data.get("mastery_label", "Unknown")
        trend = acoustic_data.get("overall_trend", 0)
        attempts = acoustic_data.get("total_attempts", 0)

        feedback_lines.append(f"[SOUND IMPRESSION] Score: {score}/100 ({mastery})")
        if attempts > 3:
            trend_str = f"+{trend:.0f}" if trend > 0 else f"{trend:.0f}"
            feedback_lines.append(f"Progress over {attempts} attempts: {trend_str} points")

        strengths = acoustic_data.get("strengths", [])
        weaknesses = acoustic_data.get("weaknesses", [])
        if strengths:
            feedback_lines.append(f"Strengths: {', '.join(strengths)}")
        if weaknesses:
            feedback_lines.append(f"Needs work: {', '.join(weaknesses)}")

    # 3. Problem-specific tips
    practice_tips = []
    problem_sounds = []
    for p in problems:
        guide = SOUND_GUIDES.get(p["type"])
        if guide:
            problem_sounds.append({
                "type": p["type"],
                "severity": p.get("severity", "medium"),
                "problem": guide["problem"],
            })
            practice_tips.append({
                "problem": guide["problem"],
                "tip": guide["tip"],
                "example": guide["example"],
                "severity": p.get("severity", "medium"),
            })

    # 4. Build concise tip string for AI
    if practice_tips:
        feedback_lines.append("")
        feedback_lines.append("Specific pronunciation tips to share with the learner:")
        for i, tip in enumerate(practice_tips[:3], 1):  # max 3 tips
            severity_emoji = "🔴" if tip["severity"] == "high" else "🟡" if tip["severity"] == "medium" else "🟢"
            feedback_lines.append(f"  {severity_emoji} {tip['problem']}")
            feedback_lines.append(f"     Tip: {tip['tip']}")
            feedback_lines.append(f"     Example: {tip['example']}")

    # 5. Mastery guidance
    if acoustic_data:
        score = acoustic_data.get("sound_impression_score", 0)
        if score >= 80:
            feedback_lines.append("")
            feedback_lines.append("This learner has mastered this word's sound impression. Consider moving to a new word.")
        elif score >= 50:
            feedback_lines.append("")
            feedback_lines.append("The learner is making progress. Focus on the specific issues above.")
        else:
            feedback_lines.append("")
            feedback_lines.append("This word needs significant practice. Break it into syllables and practice each part.")

    return {
        "word": word,
        "feedback_lines": feedback_lines,
        "feedback_text": "\n".join(feedback_lines),
        "problem_sounds": problem_sounds,
        "practice_tips": practice_tips,
        "mastery_summary": acoustic_data.get("mastery_label", "No history") if acoustic_data else "No history",
        "sound_impression_score": acoustic_data.get("sound_impression_score", 0) if acoustic_data else 0,
    }


def main():
    if len(sys.argv) < 4:
        print(json.dumps({"error": "Usage: python feedback_generator.py <phoneme.json> <history.json> <word>"}))
        sys.exit(1)

    phoneme_path = sys.argv[1]
    history_path = sys.argv[2]
    target_word = sys.argv[3]

    # Load phoneme analysis
    phoneme_data = None
    if os.path.exists(phoneme_path):
        with open(phoneme_path, 'r', encoding='utf-8') as f:
            phoneme_data = json.load(f)

    # Load acoustic representation for this word
    acoustic_data = None
    if os.path.exists(history_path):
        # Import and compute fresh
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        from acoustic_repr import compute_representation
        with open(history_path, 'r', encoding='utf-8') as f:
            records = json.load(f)
        word_records = [r for r in records if r.get("word", "").lower() == target_word.lower() and r.get("matched")]
        word_records.sort(key=lambda r: r.get("timestamp", 0))
        if word_records:
            acoustic_data = compute_representation(word_records)

    result = generate_feedback(target_word, phoneme_data, acoustic_data)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
