import { useEffect, useState, useRef, useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';

// ─── Types ───────────────────────────────────────────────────────────────
interface AcousticDimension {
  name: string;
  score: number;
  trend: number;
  attempts: number;
}

interface AcousticWordData {
  word: string;
  sound_impression_score: number;
  mastery_level: string;
  mastery_label: string;
  overall_trend: number;
  strengths: string[];
  weaknesses: string[];
  total_attempts: number;
  dimensions: {
    spectral_fidelity: AcousticDimension & { mean: number; best: number; std: number };
    articulatory_accuracy: AcousticDimension & { f1_mean: number; f2_mean: number; mean: number; best: number; std: number; detail?: { f1_issue: string; f2_issue: string } };
    temporal_control: AcousticDimension & { tendency: string; mean_ratio: number; latest_ratio: number; mean: number; best: number; std: number };
    prosodic_pattern: AcousticDimension & { mean_correlation: number; mean: number; best: number; std: number };
    voice_production: AcousticDimension & { voice_quality_mean: number; vowel_clarity_mean: number; fluency_mean: number; mean: number };
    energy_dynamics: AcousticDimension & { mean_correlation: number; mean: number; best: number; std: number };
  };
  history_summary: {
    overall_mean: number;
    overall_latest: number;
    overall_best: number;
    similarity_mean: number;
    similarity_latest: number;
    similarity_best: number;
  };
}

interface AcousticAuraProps {
  wordData: AcousticWordData | null;
  isVisible: boolean;
  onClose?: () => void;
}

// ─── Dimension Config ────────────────────────────────────────────────────
const DIMENSION_CONFIG = [
  { key: 'spectral_fidelity', label: 'Sound Shape', icon: '🎵', color: '#60a5fa', glowColor: 'rgba(96,165,250,0.4)' },
  { key: 'articulatory_accuracy', label: 'Mouth Form', icon: '👅', color: '#a78bfa', glowColor: 'rgba(167,139,250,0.4)' },
  { key: 'temporal_control', label: 'Rhythm', icon: '⏱', color: '#34d399', glowColor: 'rgba(52,211,153,0.4)' },
  { key: 'prosodic_pattern', label: 'Melody', icon: '🎶', color: '#fbbf24', glowColor: 'rgba(251,191,36,0.4)' },
  { key: 'voice_production', label: 'Voice', icon: '🗣', color: '#fb7185', glowColor: 'rgba(251,113,133,0.4)' },
  { key: 'energy_dynamics', label: 'Energy', icon: '💪', color: '#22d3ee', glowColor: 'rgba(34,211,238,0.4)' },
] as const;

// ─── Helper: Generate organic blob path ──────────────────────────────────
function generateBlobPath(scores: number[], centerX: number, centerY: number, maxRadius: number, phase: number): string {
  const points: [number, number][] = [];
  const n = scores.length;

  for (let i = 0; i < n; i++) {
    const angle = (Math.PI * 2 * i) / n - Math.PI / 2;
    const normalizedScore = Math.max(scores[i] / 100, 0.08);
    const wobble = Math.sin(phase + i * 1.3) * 0.05 + Math.cos(phase * 0.7 + i * 0.9) * 0.03;
    const r = maxRadius * (normalizedScore + wobble);
    points.push([
      centerX + Math.cos(angle) * r,
      centerY + Math.sin(angle) * r,
    ]);
  }

  let d = '';
  for (let i = 0; i < n; i++) {
    const curr = points[i];
    const next = points[(i + 1) % n];
    const prev = points[(i - 1 + n) % n];
    const next2 = points[(i + 2) % n];

    const cp1x = curr[0] + (next[0] - prev[0]) / 4;
    const cp1y = curr[1] + (next[1] - prev[1]) / 4;
    const cp2x = next[0] - (next2[0] - curr[0]) / 4;
    const cp2y = next[1] - (next2[1] - curr[1]) / 4;

    if (i === 0) d += `M ${curr[0]},${curr[1]} `;
    d += `C ${cp1x},${cp1y} ${cp2x},${cp2y} ${next[0]},${next[1]} `;
  }
  d += 'Z';
  return d;
}

// ─── Mastery to visual mapping ───────────────────────────────────────────
function getMasteryVisual(level: string): { dots: boolean[]; color: string; pulseSpeed: number } {
  switch (level) {
    case 'mastered':
      return { dots: [true, true, true, true, true, true], color: '#34d399', pulseSpeed: 4 };
    case 'proficient':
      return { dots: [true, true, true, true, true, false], color: '#60a5fa', pulseSpeed: 3.5 };
    case 'developing':
      return { dots: [true, true, true, true, false, false], color: '#fbbf24', pulseSpeed: 3 };
    case 'beginning':
      return { dots: [true, true, true, false, false, false], color: '#f97316', pulseSpeed: 2.5 };
    default:
      return { dots: [true, true, false, false, false, false], color: '#ef4444', pulseSpeed: 2 };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// LEARNER INSIGHT ENGINE — generates human-readable interpretations
// ═══════════════════════════════════════════════════════════════════════════

interface LearnerInsight {
  icon: string;
  label: string;
  message: string;
  type: 'success' | 'warning' | 'danger' | 'info';
}

function generateLearnerInsights(data: AcousticWordData): {
  headline: string;
  headlineType: 'success' | 'warning' | 'danger' | 'info';
  insights: LearnerInsight[];
  stabilityScore: number;
  stabilityLabel: string;
  focusTip: string;
} {
  const insights: LearnerInsight[] = [];
  const dims = data.dimensions;
  const scores = getScores(data);
  const trends = getScoreTrends(data);

  // ── Headline: overall status ──
  let headline = '';
  let headlineType: 'success' | 'warning' | 'danger' | 'info' = 'info';

  if (data.sound_impression_score >= 80) {
    headline = 'Your sound impression is strong! Almost there.';
    headlineType = 'success';
  } else if (data.sound_impression_score >= 60) {
    headline = 'The sound shape is forming — keep building it.';
    headlineType = 'info';
  } else if (data.sound_impression_score >= 40) {
    headline = 'Your sound is recognizable but needs more detail.';
    headlineType = 'warning';
  } else {
    headline = 'Still building the foundation — every practice counts.';
    headlineType = 'danger';
  }

  // Add trend context to headline
  if (data.overall_trend > 10) {
    headline += ' 📈 Great momentum!';
  } else if (data.overall_trend < -10) {
    headline += ' Let\'s refocus.';
  }

  // ── Per-dimension insights ──

  // 1. Spectral Fidelity (Sound Shape)
  const sf = dims.spectral_fidelity;
  if (sf.score >= 70) {
    insights.push({
      icon: '🎵', label: 'Sound Shape',
      message: `Your overall sound shape is ${sf.score}% similar to the target — the listener can recognize what you\'re saying.`,
      type: 'success',
    });
  } else if (sf.score >= 50) {
    insights.push({
      icon: '🎵', label: 'Sound Shape',
      message: `Sound similarity at ${sf.score}%. The word is partially recognizable but some sounds are off.`,
      type: 'warning',
    });
  } else if (sf.attempts > 0) {
    insights.push({
      icon: '🎵', label: 'Sound Shape',
      message: sf.score > 0
        ? `Sound similarity is only ${sf.score}%. The word sounds quite different from the target.`
        : 'Not enough data on overall sound shape yet.',
      type: sf.score > 0 ? 'danger' : 'info',
    });
  }

  // 2. Articulatory Accuracy (Mouth Form)
  const aa = dims.articulatory_accuracy;
  if (aa.attempts > 0) {
    const f1Issue = aa.detail?.f1_issue;
    const f2Issue = aa.detail?.f2_issue;

    if (aa.score >= 65) {
      insights.push({
        icon: '👅', label: 'Mouth Form',
        message: `Mouth and tongue position are accurate (${aa.score}%). Your vowels sound natural.`,
        type: 'success',
      });
    } else if (aa.score >= 40) {
      let msg = `Mouth form at ${aa.score}% — some vowel sounds need adjustment.`;
      if (f2Issue === 'tongue_position') {
        msg += ' Try shifting your tongue position slightly.';
      }
      if (f1Issue === 'mouth_opening') {
        msg += ' Pay attention to how wide you open your mouth.';
      }
      insights.push({ icon: '👅', label: 'Mouth Form', message: msg, type: 'warning' });
    } else if (aa.score > 0) {
      let msg = `Mouth form needs significant work (${aa.score}%).`;
      if (f2Issue === 'tongue_position') {
        msg += ' Your tongue position is off — try saying "ee" to feel the correct front position, then apply it.';
      }
      if (f1Issue === 'mouth_opening') {
        msg += ' Open your mouth wider for open vowels like "ah".';
      }
      insights.push({ icon: '👅', label: 'Mouth Form', message: msg, type: 'danger' });
    }

    // Trend warning for articulatory
    if (aa.trend < -10 && aa.attempts >= 3) {
      insights.push({
        icon: '📉', label: 'Mouth Form Trend',
        message: `Your mouth accuracy has been declining (${aa.trend.toFixed(0)} trend). You might be sacrificing precision for speed.`,
        type: 'danger',
      });
    }
  }

  // 3. Temporal Control (Rhythm)
  const tc = dims.temporal_control;
  if (tc.attempts > 0) {
    if (tc.score >= 80) {
      insights.push({
        icon: '⏱', label: 'Rhythm',
        message: `Great pacing! Your speaking speed is natural (${tc.score}%).`,
        type: 'success',
      });
    } else if (tc.score >= 50) {
      let msg = `Rhythm at ${tc.score}%. `;
      if (tc.tendency === 'too_slow') {
        const ratio = tc.latest_ratio || tc.mean_ratio;
        msg += `You tend to speak ${ratio.toFixed(1)}x slower than standard — try connecting syllables more smoothly.`;
      } else if (tc.tendency === 'too_fast') {
        msg += 'You\'re speaking a bit fast — slow down and pronounce each syllable clearly.';
      } else {
        msg += 'Speed is acceptable but could be more precise.';
      }
      insights.push({ icon: '⏱', label: 'Rhythm', message: msg, type: 'warning' });
    } else if (tc.score > 0) {
      let msg = `Rhythm needs work (${tc.score}%). `;
      if (tc.tendency === 'too_slow') {
        msg += `You\'re ${tc.mean_ratio.toFixed(1)}x slower than native speed. Practice saying the word as one smooth unit.`;
      } else if (tc.tendency === 'too_fast') {
        msg += 'You\'re rushing through the word. Give each syllable space to breathe.';
      }
      insights.push({ icon: '⏱', label: 'Rhythm', message: msg, type: 'danger' });
    }
  }

  // 4. Prosodic Pattern (Melody)
  const pp = dims.prosodic_pattern;
  if (pp.attempts > 0) {
    if (pp.score >= 60) {
      insights.push({
        icon: '🎶', label: 'Melody',
        message: `Your intonation pattern matches well (${pp.score}%). The word has the right melodic shape.`,
        type: 'success',
      });
    } else if (pp.score >= 30) {
      insights.push({
        icon: '🎶', label: 'Melody',
        message: `Melody match at ${pp.score}%. Your pitch rises and falls differently from the target. Try exaggerating the stress pattern.`,
        type: 'warning',
      });
    } else if (pp.score > 0) {
      insights.push({
        icon: '🎶', label: 'Melody',
        message: `Melody is quite flat (${pp.score}%). English words have a "song" — some syllables go UP and some go DOWN. Listen carefully and try to copy the melody.`,
        type: 'danger',
      });
    } else {
      // score = 0 — completely flat or anti-correlated
      if (pp.mean_correlation < 0) {
        insights.push({
          icon: '🎶', label: 'Melody',
          message: 'Your pitch pattern goes in the opposite direction. Listen to where the voice goes UP and try to mirror it.',
          type: 'danger',
        });
      } else {
        insights.push({
          icon: '🎶', label: 'Melody',
          message: 'Not enough melody data yet — keep practicing to build your intonation pattern.',
          type: 'info',
        });
      }
    }

    // Big gap between best and current
    if (pp.best >= 80 && pp.score < 40 && pp.attempts >= 3) {
      insights.push({
        icon: '💡', label: 'Potential',
        message: `You\'ve hit ${pp.best}% melody match before! You can do it — try to recreate that feeling.`,
        type: 'info',
      });
    }
  }

  // 5. Voice Production
  const vp = dims.voice_production;
  if (vp.attempts > 0) {
    const voiceQ = vp.voice_quality_mean;
    const vowelC = vp.vowel_clarity_mean;
    const fluencyV = vp.fluency_mean;

    if (vp.score >= 65) {
      insights.push({
        icon: '🗣', label: 'Voice',
        message: `Voice quality is solid (${vp.score}%). Clear vowels and smooth delivery.`,
        type: 'success',
      });
    } else {
      // Break down voice production sub-scores
      const issues: string[] = [];
      if (voiceQ < 30) issues.push('voice resonance is weak — try speaking from your chest');
      if (vowelC < 60) issues.push('vowels are unclear — open your mouth more for each vowel');
      if (fluencyV < 50) issues.push('delivery is choppy — aim for a smoother, connected flow');

      if (issues.length > 0) {
        insights.push({
          icon: '🗣', label: 'Voice',
          message: `Voice score: ${vp.score}%. Tips: ${issues.join('; ')}.`,
          type: vp.score >= 45 ? 'warning' : 'danger',
        });
      } else {
        insights.push({
          icon: '🗣', label: 'Voice',
          message: `Voice quality at ${vp.score}%. Keep practicing for stronger projection.`,
          type: 'warning',
        });
      }
    }

    // Voice improving
    if (vp.trend > 8 && vp.attempts >= 3) {
      insights.push({
        icon: '📈', label: 'Voice Trend',
        message: `Your voice quality is improving (+${vp.trend.toFixed(0)})! Your body is learning the right muscle memory.`,
        type: 'success',
      });
    }
  }

  // 6. Energy Dynamics (Stress)
  const ed = dims.energy_dynamics;
  if (ed.attempts > 0) {
    if (ed.score >= 50) {
      insights.push({
        icon: '💪', label: 'Energy',
        message: `Good stress placement (${ed.score}%). You\'re emphasizing the right syllables.`,
        type: 'success',
      });
    } else if (ed.score >= 20) {
      insights.push({
        icon: '💪', label: 'Energy',
        message: `Stress pattern at ${ed.score}%. Some syllables should be louder and longer than others. Exaggerate the emphasis.`,
        type: 'warning',
      });
    } else {
      insights.push({
        icon: '💪', label: 'Energy',
        message: ed.score > 0
          ? `Stress pattern is very flat (${ed.score}%). Every word has one BIG syllable — find it and punch it.`
          : 'The emphasis pattern is missing. Try saying the word with one syllable MUCH louder than the rest.',
        type: 'danger',
      });
    }

    // Steep decline
    if (ed.trend < -30 && ed.attempts >= 3) {
      insights.push({
        icon: '⚡', label: 'Stress Alert',
        message: 'Your stress pattern has dropped sharply. You may have stopped emphasizing the key syllable.',
        type: 'danger',
      });
    }
  }

  // ── Stability Score (how consistent is the learner?) ──
  const stds = [
    dims.spectral_fidelity?.std ?? 0,
    dims.articulatory_accuracy?.std ?? 0,
    dims.temporal_control?.std ?? 0,
    dims.prosodic_pattern?.std ?? 0,
    dims.energy_dynamics?.std ?? 0,
  ].filter(s => s > 0);

  const avgStd = stds.length > 0 ? stds.reduce((a, b) => a + b, 0) / stds.length : 0;
  const stabilityScore = Math.max(0, Math.min(100, Math.round(100 - avgStd * 2)));
  let stabilityLabel = '';
  if (stabilityScore >= 80) stabilityLabel = 'Very Consistent';
  else if (stabilityScore >= 60) stabilityLabel = 'Fairly Stable';
  else if (stabilityScore >= 40) stabilityLabel = 'Variable';
  else stabilityLabel = 'Highly Variable';

  if (data.total_attempts >= 3 && stabilityScore < 50) {
    insights.push({
      icon: '🎯', label: 'Consistency',
      message: `Your performance varies a lot between attempts. Try to find the "feeling" of your best attempt and repeat it.`,
      type: 'warning',
    });
  }

  // ── Best vs Current gap ──
  const bestGap = data.history_summary.overall_best - data.history_summary.overall_latest;
  if (bestGap >= 15 && data.total_attempts >= 3) {
    insights.push({
      icon: '⭐', label: 'Your Best',
      message: `Your best score was ${data.history_summary.overall_best} but current is ${data.history_summary.overall_latest}. You\'ve proven you can do better — aim to match your peak!`,
      type: 'info',
    });
  }

  // ── Focus tip: most impactful thing to work on ──
  let focusTip = '';
  const weightedScores = [
    { dim: 'Sound Shape 🎵', score: scores[0], weight: 0.3, trend: trends[0] },
    { dim: 'Mouth Form 👅', score: scores[1], weight: 0.25, trend: trends[1] },
    { dim: 'Rhythm ⏱', score: scores[2], weight: 0.1, trend: trends[2] },
    { dim: 'Melody 🎶', score: scores[3], weight: 0.05, trend: trends[3] },
    { dim: 'Voice 🗣', score: scores[4], weight: 0.25, trend: trends[4] },
    { dim: 'Energy 💪', score: scores[5], weight: 0.05, trend: trends[5] },
  ];

  // Find the lowest-scoring dimension with highest weight (= most impact for improvement)
  const impactSorted = weightedScores
    .filter(d => d.score < 70)
    .sort((a, b) => {
      const impactA = (100 - a.score) * a.weight;
      const impactB = (100 - b.score) * b.weight;
      return impactB - impactA;
    });

  if (impactSorted.length > 0) {
    const top = impactSorted[0];
    focusTip = `Focus on ${top.dim} for the biggest improvement. ${top.trend > 0 ? 'It\'s already improving!' : top.trend < -5 ? 'This area needs your attention.' : ''}`;
  } else {
    focusTip = 'All dimensions are strong. Focus on consistency and naturalness!';
  }

  return { headline, headlineType, insights, stabilityScore, stabilityLabel, focusTip };
}

// ─── Main Component ──────────────────────────────────────────────────────
export function AcousticAura({ wordData, isVisible, onClose }: AcousticAuraProps) {
  const [phase, setPhase] = useState(0);
  const [particles, setParticles] = useState<Array<{ id: number; x: number; y: number; size: number; delay: number; color: string }>>([]);
  const [showInsights, setShowInsights] = useState(true);
  const animRef = useRef<number>(0);
  const canvasSize = 280;
  const center = canvasSize / 2;
  const maxRadius = canvasSize * 0.36;

  // Animate the blob
  useEffect(() => {
    if (!isVisible || !wordData) return;
    let running = true;
    const animate = () => {
      if (!running) return;
      setPhase(p => p + 0.008);
      animRef.current = requestAnimationFrame(animate);
    };
    animRef.current = requestAnimationFrame(animate);
    return () => { running = false; cancelAnimationFrame(animRef.current); };
  }, [isVisible, wordData]);

  // Generate floating particles
  useEffect(() => {
    if (!wordData) return;
    const p: typeof particles = [];
    const scores = getScores(wordData);
    for (let i = 0; i < 24; i++) {
      const dimIdx = i % 6;
      const score = scores[dimIdx];
      if (score < 10) continue;
      const angle = (Math.PI * 2 * dimIdx) / 6 - Math.PI / 2 + (Math.random() - 0.5) * 0.8;
      const dist = maxRadius * (score / 100) * (0.6 + Math.random() * 0.6);
      p.push({
        id: i,
        x: center + Math.cos(angle) * dist,
        y: center + Math.sin(angle) * dist,
        size: 1 + Math.random() * 3,
        delay: Math.random() * 5,
        color: DIMENSION_CONFIG[dimIdx].color,
      });
    }
    setParticles(p);
  }, [wordData]);

  const scores = useMemo(() => wordData ? getScores(wordData) : [0, 0, 0, 0, 0, 0], [wordData]);
  const mastery = useMemo(() => wordData ? getMasteryVisual(wordData.mastery_level) : getMasteryVisual('novice'), [wordData]);
  const learnerInsights = useMemo(() => wordData ? generateLearnerInsights(wordData) : null, [wordData]);

  if (!wordData) return null;

  const blobPath = generateBlobPath(scores, center, center, maxRadius, phase);
  const impressionScore = wordData.sound_impression_score;

  const weakDims = DIMENSION_CONFIG.map((dim, i) => ({
    ...dim,
    score: scores[i],
    isWeak: scores[i] < 40,
    isStrong: scores[i] >= 65,
  }));

  const insightTypeStyles = {
    success: { bg: 'rgba(52,211,153,0.06)', border: 'rgba(52,211,153,0.15)', color: '#34d399', dot: '#34d399' },
    warning: { bg: 'rgba(251,191,36,0.06)', border: 'rgba(251,191,36,0.15)', color: '#fbbf24', dot: '#fbbf24' },
    danger: { bg: 'rgba(239,68,68,0.06)', border: 'rgba(239,68,68,0.15)', color: '#ef4444', dot: '#ef4444' },
    info: { bg: 'rgba(96,165,250,0.06)', border: 'rgba(96,165,250,0.15)', color: '#60a5fa', dot: '#60a5fa' },
  };

  return (
    <AnimatePresence>
      {isVisible && (
        <motion.div
          initial={{ opacity: 0, scale: 0.9, y: 20 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.9, y: 20 }}
          transition={{ type: 'spring', damping: 25, stiffness: 200 }}
          className="p-5 rounded-3xl bg-zinc-900/60 border border-white/5 backdrop-blur-xl relative overflow-hidden"
        >
          {/* Close button */}
          {onClose && (
            <button
              onClick={onClose}
              className="absolute top-4 right-4 w-6 h-6 rounded-full bg-white/5 hover:bg-white/10 flex items-center justify-center text-zinc-500 hover:text-white transition-colors z-20"
            >
              ✕
            </button>
          )}

          {/* ══════════ SECTION 1: Sound Impression Badge ══════════ */}
          <div className="flex items-center justify-center mb-3">
            <div
              className="flex items-center gap-2.5 px-4 py-2 rounded-full border backdrop-blur-md"
              style={{ borderColor: mastery.color + '30', background: mastery.color + '08' }}
            >
              <span className="text-[10px] uppercase tracking-[0.2em] font-bold" style={{ color: mastery.color }}>
                Sound Profile
              </span>
              <div className="flex gap-1">
                {mastery.dots.map((filled, i) => (
                  <motion.div
                    key={i}
                    animate={filled ? { scale: [1, 1.2, 1], opacity: [0.7, 1, 0.7] } : {}}
                    transition={{ duration: mastery.pulseSpeed, repeat: Infinity, delay: i * 0.2 }}
                    className="w-2 h-2 rounded-full transition-all"
                    style={{
                      background: filled ? mastery.color : 'rgba(255,255,255,0.08)',
                      boxShadow: filled ? `0 0 8px ${mastery.color}50` : 'none',
                    }}
                  />
                ))}
              </div>
            </div>
          </div>

          {/* ══════════ SECTION 2: Headline Insight ══════════ */}
          {learnerInsights && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.2 }}
              className="mb-3 px-3 py-2 rounded-xl text-center"
              style={{
                background: insightTypeStyles[learnerInsights.headlineType].bg,
                border: `1px solid ${insightTypeStyles[learnerInsights.headlineType].border}`,
              }}
            >
              <p className="text-[11px] leading-relaxed font-medium" style={{ color: insightTypeStyles[learnerInsights.headlineType].color }}>
                {learnerInsights.headline}
              </p>
            </motion.div>
          )}

          {/* ══════════ SECTION 3: Central Aura Visualization ══════════ */}
          <div className="relative mx-auto" style={{ width: canvasSize, height: canvasSize }}>
            {/* Background glow */}
            <svg
              viewBox={`0 0 ${canvasSize} ${canvasSize}`}
              className="absolute inset-0 w-full h-full"
              style={{ filter: 'blur(30px)', opacity: 0.4 }}
            >
              <path d={blobPath} fill={mastery.color} />
            </svg>

            {/* Main SVG */}
            <svg viewBox={`0 0 ${canvasSize} ${canvasSize}`} className="relative w-full h-full">
              <defs>
                <radialGradient id="auraGrad" cx="50%" cy="50%" r="50%">
                  <stop offset="0%" stopColor={mastery.color} stopOpacity="0.25" />
                  <stop offset="60%" stopColor={mastery.color} stopOpacity="0.1" />
                  <stop offset="100%" stopColor={mastery.color} stopOpacity="0" />
                </radialGradient>
                <filter id="auraGlow" x="-50%" y="-50%" width="200%" height="200%">
                  <feGaussianBlur stdDeviation="6" result="blur" />
                  <feComposite in="SourceGraphic" in2="blur" operator="over" />
                </filter>
              </defs>

              {/* Radar grid */}
              {[0.25, 0.5, 0.75, 1].map((r) => (
                <polygon
                  key={r}
                  points={DIMENSION_CONFIG.map((_, i) => {
                    const angle = (Math.PI * 2 * i) / 6 - Math.PI / 2;
                    return `${center + Math.cos(angle) * maxRadius * r},${center + Math.sin(angle) * maxRadius * r}`;
                  }).join(' ')}
                  fill="none" stroke="rgba(255,255,255,0.03)" strokeWidth="0.5"
                />
              ))}

              {/* Axis lines */}
              {DIMENSION_CONFIG.map((_, i) => {
                const angle = (Math.PI * 2 * i) / 6 - Math.PI / 2;
                return (
                  <line key={i} x1={center} y1={center}
                    x2={center + Math.cos(angle) * maxRadius}
                    y2={center + Math.sin(angle) * maxRadius}
                    stroke="rgba(255,255,255,0.03)" strokeWidth="0.5" />
                );
              })}

              {/* Living blob */}
              <motion.path
                d={blobPath} fill="url(#auraGrad)"
                stroke={mastery.color} strokeWidth="1.5" strokeOpacity="0.5"
                filter="url(#auraGlow)"
                initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 1 }}
              />

              {/* Color dimension patches */}
              {weakDims.map((dim, i) => {
                if (dim.score < 5) return null;
                const angle = (Math.PI * 2 * i) / 6 - Math.PI / 2;
                const nextAngle = (Math.PI * 2 * ((i + 1) % 6)) / 6 - Math.PI / 2;
                const r = maxRadius * Math.max(dim.score / 100, 0.08);
                const wobble = Math.sin(phase + i * 1.3) * 0.05;
                const rr = r * (1 + wobble);
                const path = `M ${center},${center} L ${center + Math.cos(angle) * rr},${center + Math.sin(angle) * rr} A ${rr} ${rr} 0 0 1 ${center + Math.cos(nextAngle) * rr},${center + Math.sin(nextAngle) * rr} Z`;
                return (
                  <path key={dim.key} d={path} fill={dim.color}
                    fillOpacity={dim.isStrong ? 0.15 : dim.isWeak ? 0.03 : 0.08} stroke="none" />
                );
              })}

              {/* Floating particles */}
              {particles.map((p) => (
                <motion.circle key={p.id} cx={p.x} cy={p.y} r={p.size} fill={p.color}
                  initial={{ opacity: 0 }}
                  animate={{
                    opacity: [0, 0.6, 0],
                    cx: [p.x, p.x + (Math.random() - 0.5) * 20, p.x],
                    cy: [p.y, p.y + (Math.random() - 0.5) * 20, p.y],
                  }}
                  transition={{ duration: 3 + Math.random() * 2, repeat: Infinity, delay: p.delay, ease: 'easeInOut' }}
                />
              ))}

              {/* Dimension nodes */}
              {weakDims.map((dim, i) => {
                const angle = (Math.PI * 2 * i) / 6 - Math.PI / 2;
                const nodeR = maxRadius + 14;
                const nx = center + Math.cos(angle) * nodeR;
                const ny = center + Math.sin(angle) * nodeR;
                const dotSize = 3 + (dim.score / 100) * 5;
                return (
                  <g key={dim.key}>
                    <line
                      x1={center + Math.cos(angle) * maxRadius * Math.max(dim.score / 100, 0.08)}
                      y1={center + Math.sin(angle) * maxRadius * Math.max(dim.score / 100, 0.08)}
                      x2={nx} y2={ny} stroke={dim.color} strokeWidth="0.5"
                      strokeOpacity={dim.isWeak ? 0.15 : 0.3}
                      strokeDasharray={dim.isWeak ? '2,3' : 'none'} />
                    <circle cx={nx} cy={ny} r={dotSize + 4} fill={dim.color} opacity={0.1} />
                    <motion.circle cx={nx} cy={ny} r={dotSize}
                      fill={dim.isWeak ? 'rgba(255,255,255,0.05)' : dim.color}
                      fillOpacity={dim.isWeak ? 0.3 : 0.7}
                      stroke={dim.color} strokeWidth="1" strokeOpacity={dim.isWeak ? 0.2 : 0.5}
                      animate={dim.isStrong ? { r: [dotSize, dotSize + 1.5, dotSize], fillOpacity: [0.7, 1, 0.7] } : {}}
                      transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }} />
                  </g>
                );
              })}

              {/* Center score */}
              <text x={center} y={center - 6} textAnchor="middle" fontSize="24" fontWeight="700"
                fill={mastery.color} opacity="0.9">{impressionScore}</text>
              <text x={center} y={center + 12} textAnchor="middle" fontSize="7" fontWeight="500"
                fill="rgba(255,255,255,0.3)" letterSpacing="2.5">IMPRESSION</text>
            </svg>
          </div>

          {/* ══════════ SECTION 4: Dimension Legend Grid ══════════ */}
          <div className="grid grid-cols-3 gap-1.5 mt-2">
            {weakDims.map((dim, i) => (
              <motion.div key={dim.key} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.1 + i * 0.08 }}
                className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg transition-all"
                style={{
                  background: dim.isWeak ? 'rgba(239,68,68,0.05)' : dim.isStrong ? dim.color + '0a' : 'rgba(255,255,255,0.02)',
                  border: `1px solid ${dim.isWeak ? 'rgba(239,68,68,0.15)' : dim.color + '15'}`,
                }}>
                <span className="text-xs">{dim.icon}</span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1">
                    <div className="flex-1 h-1 bg-zinc-800 rounded-full overflow-hidden">
                      <motion.div initial={{ width: 0 }} animate={{ width: `${dim.score}%` }}
                        transition={{ duration: 0.8, delay: 0.2 + i * 0.1 }}
                        className="h-full rounded-full"
                        style={{ background: dim.isWeak ? '#ef4444' : dim.color }} />
                    </div>
                    <span className="text-[8px] font-mono w-5 text-right" style={{ color: dim.color + '99' }}>
                      {dim.score}
                    </span>
                    {getScoreTrends(wordData)[i] !== 0 && (
                      <span className="text-[8px] font-bold"
                        style={{ color: getScoreTrends(wordData)[i] > 0 ? '#34d399' : '#ef4444' }}>
                        {getScoreTrends(wordData)[i] > 0 ? '↑' : '↓'}
                      </span>
                    )}
                  </div>
                </div>
              </motion.div>
            ))}
          </div>

          {/* ══════════ SECTION 5: Practice Stats Row ══════════ */}
          <div className="mt-3 flex items-center justify-between px-1">
            <div className="flex items-center gap-3">
              {/* Practice count */}
              <div className="flex items-center gap-1">
                <div className="w-1.5 h-1.5 rounded-full bg-zinc-600" />
                <span className="text-[9px] text-zinc-500 font-mono">
                  {wordData.total_attempts}x practiced
                </span>
              </div>
              {/* Trend */}
              {wordData.overall_trend !== 0 && (
                <div className="flex items-center gap-1">
                  <motion.span
                    animate={{ y: wordData.overall_trend > 0 ? [-1, 1, -1] : [1, -1, 1] }}
                    transition={{ duration: 2, repeat: Infinity }}
                    className="text-[10px]"
                    style={{ color: wordData.overall_trend > 0 ? '#34d399' : '#ef4444' }}
                  >
                    {wordData.overall_trend > 0 ? '▲' : '▼'}
                  </motion.span>
                  <span className="text-[9px] font-mono font-bold"
                    style={{ color: wordData.overall_trend > 0 ? '#34d399' : '#ef4444' }}>
                    {wordData.overall_trend > 0 ? '+' : ''}{wordData.overall_trend.toFixed(1)}
                  </span>
                </div>
              )}
            </div>
            {/* Stability badge */}
            {learnerInsights && wordData.total_attempts >= 2 && (
              <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-full"
                style={{
                  background: learnerInsights.stabilityScore >= 60 ? 'rgba(52,211,153,0.06)' : 'rgba(251,191,36,0.06)',
                  border: `1px solid ${learnerInsights.stabilityScore >= 60 ? 'rgba(52,211,153,0.15)' : 'rgba(251,191,36,0.15)'}`,
                }}>
                <span className="text-[8px]">🎯</span>
                <span className="text-[8px] font-bold"
                  style={{ color: learnerInsights.stabilityScore >= 60 ? '#34d399' : '#fbbf24' }}>
                  {learnerInsights.stabilityLabel}
                </span>
              </div>
            )}
          </div>

          {/* ══════════ SECTION 6: Toggle Insights Button ══════════ */}
          <button
            onClick={() => setShowInsights(!showInsights)}
            className="w-full mt-3 py-2 rounded-xl bg-white/[0.02] border border-white/5 hover:bg-white/[0.04] transition-all flex items-center justify-center gap-2 group"
          >
            <span className="text-[10px] uppercase tracking-wider font-bold text-zinc-500 group-hover:text-zinc-300 transition-colors">
              {showInsights ? 'Hide' : 'Show'} Sound Insights
            </span>
            <motion.span
              animate={{ rotate: showInsights ? 180 : 0 }}
              className="text-zinc-500 text-xs"
            >
              ▼
            </motion.span>
          </button>

          {/* ══════════ SECTION 7: Learner Insights Panel ══════════ */}
          <AnimatePresence>
            {showInsights && learnerInsights && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ type: 'spring', damping: 25, stiffness: 200 }}
                className="overflow-hidden"
              >
                <div className="mt-3 space-y-2">
                  {/* ── Focus Recommendation ── */}
                  <motion.div
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: 0.1 }}
                    className="px-3 py-2.5 rounded-xl bg-gradient-to-r from-blue-500/5 to-violet-500/5 border border-blue-500/10"
                  >
                    <div className="flex items-start gap-2">
                      <span className="text-sm mt-0.5">🎯</span>
                      <div>
                        <p className="text-[9px] uppercase tracking-wider font-bold text-blue-400/70 mb-0.5">Priority Focus</p>
                        <p className="text-[11px] text-zinc-300 leading-relaxed">{learnerInsights.focusTip}</p>
                      </div>
                    </div>
                  </motion.div>

                  {/* ── Individual Insights ── */}
                  {learnerInsights.insights.map((insight, i) => {
                    const style = insightTypeStyles[insight.type];
                    return (
                      <motion.div
                        key={`${insight.label}-${i}`}
                        initial={{ opacity: 0, x: -10 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ delay: 0.15 + i * 0.06 }}
                        className="px-3 py-2 rounded-xl flex items-start gap-2"
                        style={{ background: style.bg, border: `1px solid ${style.border}` }}
                      >
                        <span className="text-sm mt-0.5 shrink-0">{insight.icon}</span>
                        <div className="min-w-0">
                          <p className="text-[11px] leading-relaxed" style={{ color: style.color + 'dd' }}>
                            {insight.message}
                          </p>
                        </div>
                      </motion.div>
                    );
                  })}

                  {/* ── Progress Journey ── */}
                  {wordData.total_attempts >= 2 && (
                    <motion.div
                      initial={{ opacity: 0, x: -10 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: 0.15 + learnerInsights.insights.length * 0.06 }}
                      className="px-3 py-2.5 rounded-xl bg-zinc-800/30 border border-white/5"
                    >
                      <p className="text-[9px] uppercase tracking-wider font-bold text-zinc-500 mb-2">Journey</p>
                      <div className="flex items-center gap-2">
                        {/* Progress bar: mean → latest → best */}
                        <div className="flex-1">
                          <div className="relative h-2 bg-zinc-800 rounded-full overflow-hidden">
                            {/* Mean line marker */}
                            <div
                              className="absolute top-0 h-full w-0.5 bg-zinc-500/50 z-10"
                              style={{ left: `${wordData.history_summary.overall_mean}%` }}
                              title={`Average: ${wordData.history_summary.overall_mean}`}
                            />
                            {/* Best marker */}
                            <div
                              className="absolute top-0 h-full w-0.5 bg-emerald-500/50 z-10"
                              style={{ left: `${wordData.history_summary.overall_best}%` }}
                              title={`Best: ${wordData.history_summary.overall_best}`}
                            />
                            {/* Current fill */}
                            <motion.div
                              initial={{ width: 0 }}
                              animate={{ width: `${wordData.history_summary.overall_latest}%` }}
                              transition={{ duration: 1, delay: 0.3 }}
                              className="h-full rounded-full"
                              style={{ background: mastery.color }}
                            />
                          </div>
                          <div className="flex justify-between mt-1">
                            <span className="text-[8px] text-zinc-600 font-mono">
                              avg {wordData.history_summary.overall_mean}
                            </span>
                            <span className="text-[8px] font-mono font-bold" style={{ color: mastery.color }}>
                              now {wordData.history_summary.overall_latest}
                            </span>
                            <span className="text-[8px] text-emerald-500/70 font-mono">
                              best {wordData.history_summary.overall_best}
                            </span>
                          </div>
                        </div>
                      </div>
                    </motion.div>
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────
function getScores(data: AcousticWordData): number[] {
  return [
    data.dimensions.spectral_fidelity?.score ?? 0,
    data.dimensions.articulatory_accuracy?.score ?? 0,
    data.dimensions.temporal_control?.score ?? 0,
    data.dimensions.prosodic_pattern?.score ?? 0,
    data.dimensions.voice_production?.score ?? 0,
    data.dimensions.energy_dynamics?.score ?? 0,
  ];
}

function getScoreTrends(data: AcousticWordData): number[] {
  return [
    data.dimensions.spectral_fidelity?.trend ?? 0,
    data.dimensions.articulatory_accuracy?.trend ?? 0,
    data.dimensions.temporal_control?.trend ?? 0,
    data.dimensions.prosodic_pattern?.trend ?? 0,
    data.dimensions.voice_production?.trend ?? 0,
    data.dimensions.energy_dynamics?.trend ?? 0,
  ];
}

function mapStrengthName(name: string): string {
  const map: Record<string, string> = {
    'Spectral Fidelity': 'Sound Shape',
    'Articulatory Accuracy': 'Mouth Form',
    'Temporal Control': 'Rhythm',
    'Prosodic Pattern': 'Melody',
    'Voice Production': 'Voice',
    'Energy Dynamics': 'Energy',
  };
  return map[name] || name;
}


