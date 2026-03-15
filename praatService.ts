/**
 * Praat Service — Handles pronunciation analysis via Praat CLI.
 * Converts raw PCM buffers to WAV, runs Praat analysis script,
 * parses results and computes pronunciation scores.
 */

import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Resolve Praat executable path relative to project root
const PRAAT_EXE = path.join(process.cwd(), 'praat', 'Praat.exe');
const PRAAT_SCRIPT = path.join(process.cwd(), 'praat', 'analyze.praat');
const PRAAT_COMPARE_SCRIPT = path.join(process.cwd(), 'praat', 'compare.praat');
const QUERY_VOWELS_SCRIPT = path.join(process.cwd(), 'praat', 'query_vowels.praat');
const ALIGN_SCRIPT = path.join(process.cwd(), 'praat', 'align.py');
const MFCC_DTW_SCRIPT = path.join(process.cwd(), 'praat', 'mfcc_dtw.py');
const PHONEME_SCRIPT = path.join(process.cwd(), 'praat', 'phoneme_analysis.py');
const FORCED_ALIGN_SCRIPT = path.join(process.cwd(), 'scripts', 'forced_align.py');

// Use .venv Python if available (has numpy, torch, etc.), fallback to system python
const VENV_PYTHON = path.join(process.cwd(), '.venv', 'Scripts', 'python.exe');
const PYTHON_EXE = fs.existsSync(VENV_PYTHON) ? VENV_PYTHON : 'python';

// Toggle server-side debug logging: set ECHOMIND_DEBUG=1 in environment
const DEBUG = !!process.env.ECHOMIND_DEBUG;
function sdbg(tag: string, msg: string, ...args: any[]) {
  if (!DEBUG) return;
  const ts = new Date().toISOString().slice(11, 23);
  if (args.length > 0) {
    console.log(`[${ts}] [DBG:${tag}] ${msg}`, ...args);
  } else {
    console.log(`[${ts}] [DBG:${tag}] ${msg}`);
  }
}

/**
 * Use Whisper to find the target word's start/end timestamps in a WAV file.
 * Returns {found, start, end} or {found: false} if word not detected.
 */
async function whisperAlign(wavPath: string, targetWord: string, useHint: boolean = false): Promise<{ found: boolean; start?: number; end?: number; word?: string; all_words?: { word: string; start: number; end: number; probability: number }[] }> {
  return new Promise((resolve) => {
    const args = [ALIGN_SCRIPT, wavPath, targetWord];
    if (useHint) args.push('--hint');
    execFile(PYTHON_EXE, args, { timeout: 30000 }, (err, stdout, stderr) => {
      if (err) {
        console.warn(`[Whisper] ⚠️ Alignment failed: ${err.message}`);
        resolve({ found: false });
        return;
      }
      try {
        const result = JSON.parse(stdout.trim());
        resolve(result);
      } catch (e) {
        console.warn(`[Whisper] ⚠️ Parse error: ${stdout}`);
        resolve({ found: false });
      }
    });
  });
}

/**
 * Extract a segment from a WAV file (with header) by time range.
 * Returns a new WAV buffer containing only the specified segment.
 */
function extractWavSegment(wavBuffer: Buffer, sampleRate: number, startSec: number, endSec: number, label: string = 'unknown'): Buffer {
  const headerSize = 44;
  const bytesPerSample = 2; // 16-bit
  const startByte = headerSize + Math.floor(startSec * sampleRate * bytesPerSample);
  const endByte = Math.min(wavBuffer.length, headerSize + Math.ceil(endSec * sampleRate * bytesPerSample));
  const segmentBytes = endByte - startByte;
  const segmentSamples = segmentBytes / bytesPerSample;
  const segmentDuration = segmentSamples / sampleRate;

  sdbg('audio', `[extractWavSegment:${label}] startSec=${startSec.toFixed(3)}s endSec=${endSec.toFixed(3)}s → startByte=${startByte} endByte=${endByte} segBytes=${segmentBytes} samples=${segmentSamples} dur=${segmentDuration.toFixed(3)}s @${sampleRate}Hz`);
  sdbg('audio', `[extractWavSegment:${label}] totalWavSize=${wavBuffer.length} headerSize=${headerSize} totalPcmBytes=${wavBuffer.length - headerSize}`);

  if (segmentBytes <= 0) {
    sdbg('audio', `[extractWavSegment:${label}] ⚠️ EMPTY SEGMENT! startByte(${startByte}) >= endByte(${endByte})`);
  }

  const pcmSegment = wavBuffer.slice(startByte, endByte);

  // Analyze the extracted PCM quality
  if (pcmSegment.length >= 2) {
    const samples = new Int16Array(pcmSegment.buffer, pcmSegment.byteOffset, pcmSegment.length / 2);
    let maxAmp = 0, zeroCount = 0, sumSq = 0, jumps = 0;
    for (let i = 0; i < samples.length; i++) {
      const a = Math.abs(samples[i]);
      if (a > maxAmp) maxAmp = a;
      if (a === 0) zeroCount++;
      sumSq += samples[i] * samples[i];
      if (i > 0 && Math.abs(samples[i] - samples[i - 1]) > 15000) jumps++;
    }
    const rms = Math.sqrt(sumSq / samples.length);
    sdbg('audio', `[extractWavSegment:${label}] PCM stats: maxAmp=${maxAmp}/32768 zeroPct=${((zeroCount / samples.length) * 100).toFixed(1)}% RMS=${rms.toFixed(1)} largeJumps=${jumps}`);
  }

  return pcmToWav(pcmSegment, sampleRate);
}

export interface PraatRawResult {
  success: boolean;
  pitch: { mean: number; min: number; max: number; stdev: number };
  formants: { f1_mean: number; f2_mean: number; f3_mean: number };
  intensity: { mean: number; min: number; max: number; stdev: number };
  duration: number;
  voicedFraction: number;
  jitter: number;
  shimmer: number;
  hnr: number;
  speechRate: number;
}

export interface PronunciationScore {
  overall: number;          // 0-100
  pitchStability: number;   // 0-100
  vowelClarity: number;     // 0-100
  voiceQuality: number;     // 0-100
  fluency: number;          // 0-100
  details: PraatRawResult;
  feedback: string[];
  comparison?: ComparisonResult;  // Added: optional comparison with reference
}

export interface VowelAnalysis {
  syllableIndex: number;         // 0-based
  syllable: string;              // "hy", "POTH", etc.
  isStressed: boolean;           // true if this is the stressed syllable
  vowel: string;                 // ARPAbet: "AY", "AA", etc.
  refF1: number;                 // ref average F1 for this syllable
  refF2: number;
  userF1: number;                // user average F1 for this syllable
  userF2: number;
  f1Similarity: number;          // 0-100
  f2Similarity: number;          // 0-100
  overallMatch: number;          // 0-100 (avg of f1+f2)
  f1Direction: 'ok' | 'too_open' | 'too_closed';  // mouth guidance
  f2Direction: 'ok' | 'too_front' | 'too_back';   // tongue guidance
  tip: string;                   // actionable tip with reference word
}

export interface ComparisonResult {
  pitchCorrelation: number;      // -1 to 1 (1 = perfect match)
  durationRatio: number;         // user/ref ratio (1 = same speed)
  f1Similarity: number;          // 0-100%
  f2Similarity: number;          // 0-100%
  intensityCorrelation: number;  // -1 to 1
  overallSimilarity: number;     // 0-100 weighted
  // Pre-computed sub-scores (0-100) for frontend display
  mfccScore: number;
  pitchScore: number;
  durationScore: number;
  formantScore: number;
  intensityScore: number;
  ref: { meanPitch: number; f1: number; f2: number; duration: number; meanIntensity: number };
  user: { meanPitch: number; f1: number; f2: number; duration: number; meanIntensity: number };
  pitchContour: { ref: number[]; user: number[] };  // for visualization
  vowelAnalysis?: VowelAnalysis[];  // per-syllable vowel analysis
  feedback: string[];
  audioTimestamp?: number;  // cache-busting timestamp for audio playback URLs
}

/**
 * Convert PCM Int16 buffer (16kHz mono) to WAV file
 */
function pcmToWav(pcmBuffer: Buffer, sampleRate: number = 16000, channels: number = 1, bitsPerSample: number = 16): Buffer {
  const dataSize = pcmBuffer.length;
  const header = Buffer.alloc(44);

  // RIFF header
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);

  // fmt subchunk
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);           // subchunk size
  header.writeUInt16LE(1, 20);            // PCM format
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * bitsPerSample / 8, 28); // byte rate
  header.writeUInt16LE(channels * bitsPerSample / 8, 32);             // block align
  header.writeUInt16LE(bitsPerSample, 34);

  // data subchunk
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcmBuffer]);
}

/**
 * Trim silence from PCM buffer using RMS energy detection.
 * Finds the first and last regions with speech and returns only that portion.
 * Conservative approach: preserves consonants and soft speech segments.
 */
function trimSilence(pcmBuffer: Buffer, sampleRate: number, label: string = ''): Buffer {
  const totalDuration = pcmBuffer.length / 2 / sampleRate;

  // Don't trim if audio is already short — it's likely all speech
  if (totalDuration <= 2.0) {
    console.log(`[PraatService] ✂️ trimSilence (${label}): ${totalDuration.toFixed(2)}s — skipping (already ≤ 2s)`);
    return pcmBuffer;
  }

  const samples = new Int16Array(pcmBuffer.buffer, pcmBuffer.byteOffset, pcmBuffer.length / 2);
  if (samples.length === 0) return pcmBuffer;

  // Analyze in 25ms windows with 10ms hop
  const windowSize = Math.floor(sampleRate * 0.025);
  const hopSize = Math.floor(sampleRate * 0.010);
  const energies: number[] = [];

  for (let i = 0; i <= samples.length - windowSize; i += hopSize) {
    let sum = 0;
    for (let j = 0; j < windowSize; j++) {
      sum += samples[i + j] * samples[i + j];
    }
    energies.push(Math.sqrt(sum / windowSize));
  }

  if (energies.length === 0) return pcmBuffer;

  // Threshold = 2% of max energy (ultra-conservative — preserves 'h', 's', 'f' onsets)
  const maxEnergy = Math.max(...energies);
  const threshold = maxEnergy * 0.02;

  // Find first and last windows above threshold
  let startWindow = 0;
  let endWindow = energies.length - 1;

  for (let i = 0; i < energies.length; i++) {
    if (energies[i] > threshold) {
      startWindow = Math.max(0, i - 50);  // 500ms padding before (preserves soft word onsets like 'h')
      break;
    }
  }

  for (let i = energies.length - 1; i >= 0; i--) {
    if (energies[i] > threshold) {
      endWindow = Math.min(energies.length - 1, i + 50);  // 500ms padding after
      break;
    }
  }

  // Convert window indices to byte offsets (each sample = 2 bytes)
  const startByte = startWindow * hopSize * 2;
  const endByte = Math.min(pcmBuffer.length, (endWindow * hopSize + windowSize) * 2);

  const trimmed = pcmBuffer.slice(startByte, endByte);
  const trimDur = (trimmed.length / 2 / sampleRate).toFixed(2);

  // Safety: ensure trimmed result is at least 0.5s — if not, return original
  if (trimmed.length < sampleRate * 2 * 0.5) {
    console.log(`[PraatService] ✂️ trimSilence (${label}): ${totalDuration.toFixed(2)}s — trim result too short (${trimDur}s), keeping original`);
    return pcmBuffer;
  }

  console.log(`[PraatService] ✂️ trimSilence (${label}): ${totalDuration.toFixed(2)}s → ${trimDur}s (removed ${(totalDuration - parseFloat(trimDur)).toFixed(2)}s silence)`);

  return trimmed;
}

/**
 * Run Praat analysis on a PCM audio buffer
 */
export async function analyzePronunciation(pcmBase64Chunks: string[], sampleRate: number = 16000): Promise<PronunciationScore> {
  const combinedPCM = Buffer.concat(pcmBase64Chunks.map(c => Buffer.from(c, 'base64')));
  const audioDuration = (combinedPCM.length / (sampleRate * 2)).toFixed(2);

  // Quick amplitude check
  const pcm16 = new Int16Array(combinedPCM.buffer, combinedPCM.byteOffset, combinedPCM.length / 2);
  let maxAmp = 0;
  for (let i = 0; i < pcm16.length; i++) { const a = Math.abs(pcm16[i]); if (a > maxAmp) maxAmp = a; }
  console.log(`[PraatService] 📦 ${pcmBase64Chunks.length} chunks, ${audioDuration}s @${sampleRate}Hz, maxAmp=${maxAmp}/32768`);
  if (maxAmp < 500) console.warn(`[PraatService] ⚠️ Very quiet audio (maxAmp=${maxAmp}) — mic issue?`);

  if (combinedPCM.length < 9600) {
    return createEmptyScore('Audio too short for analysis.');
  }

  const wavBuffer = pcmToWav(combinedPCM, sampleRate);
  const wavPath = path.join(os.tmpdir(), `echomind_${Date.now()}.wav`);
  fs.writeFileSync(wavPath, wavBuffer);

  // Save debug copy
  const debugDir = path.join(process.cwd(), 'debug');
  if (!fs.existsSync(debugDir)) fs.mkdirSync(debugDir, { recursive: true });
  fs.copyFileSync(wavPath, path.join(debugDir, 'last_recording.wav'));

  try {
    console.log(`[PraatService] 🔬 Running Praat analysis...`);
    const startTime = Date.now();
    const result = await runPraat(wavPath);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);

    console.log(`[PraatService] ✅ Praat completed in ${elapsed}s`);
    console.log(`[PraatService] 📊 Raw results:`, JSON.stringify(result, null, 2));

    const score = computeScore(result);
    console.log(`[PraatService] 🏆 Scores → Overall: ${score.overall} | Pitch: ${score.pitchStability} | Vowel: ${score.vowelClarity} | Voice: ${score.voiceQuality} | Fluency: ${score.fluency}`);
    console.log(`[PraatService] 💬 Feedback: ${score.feedback.join(' | ')}`);

    return score;
  } catch (err) {
    console.error('[PraatService] ❌ Analysis failed:', err);
    return createEmptyScore('Praat analysis failed. Please try again.');
  } finally {
    // Cleanup temp file (debug copy is kept)
    try { fs.unlinkSync(wavPath); } catch { }
  }
}

/**
 * Execute Praat script and parse JSON output
 */
function runPraat(wavPath: string): Promise<PraatRawResult> {
  return new Promise((resolve, reject) => {
    // Use --run for headless mode, --utf8 for proper encoding
    execFile(
      PRAAT_EXE,
      ['--run', '--utf8', PRAAT_SCRIPT, wavPath],
      { timeout: 15000, maxBuffer: 1024 * 512 },
      (error, stdout, stderr) => {
        if (error) {
          console.error('[PraatService] Praat error:', error.message);
          console.error('[PraatService] stderr:', stderr);
          reject(error);
          return;
        }

        try {
          // Praat outputs in UTF-16 on Windows by default, but we use --utf8
          const output = stdout.toString().trim();
          const result = JSON.parse(output);
          resolve(result as PraatRawResult);
        } catch (parseErr) {
          console.error('[PraatService] Failed to parse Praat output:', stdout);
          reject(parseErr);
        }
      }
    );
  });
}

/**
 * Compute pronunciation scores from Praat raw data
 * Thresholds are calibrated for real conversational audio
 * captured through typical microphones (not studio quality).
 */
function computeScore(raw: PraatRawResult): PronunciationScore {
  const feedback: string[] = [];

  // =============================================
  // 1. Pitch Stability (informational only, weight=0)
  // Not included in overall score — unreliable for single-word
  // tasks due to Praat octave jumps and noise artifacts.
  // Still computed for diagnostic/debug purposes.
  // =============================================
  let pitchStability = 100;
  if (raw.pitch.mean > 0) {
    const cv = raw.pitch.stdev / raw.pitch.mean;
    pitchStability = Math.max(0, Math.min(100, Math.round(100 * (1 - cv * 1.8))));
  } else {
    pitchStability = 0;
  }

  // =============================================
  // 2. Vowel Clarity (30%)
  // Based on formant distinctiveness (F1/F2 separation)
  // Typical F2/F1 ratio for clear English vowels: 1.3 to 3.5
  // =============================================
  let vowelClarity = 70;
  if (raw.formants.f1_mean > 0 && raw.formants.f2_mean > 0) {
    const f1f2Ratio = raw.formants.f2_mean / raw.formants.f1_mean;
    if (f1f2Ratio >= 1.3 && f1f2Ratio <= 3.5) {
      vowelClarity = Math.min(100, Math.round(55 + (f1f2Ratio - 1.3) * 20));
    } else if (f1f2Ratio < 1.3) {
      vowelClarity = Math.round(f1f2Ratio / 1.3 * 55);
    } else {
      vowelClarity = Math.max(30, Math.round(100 - (f1f2Ratio - 3.5) * 15));
    }

    if (vowelClarity < 50) {
      feedback.push('Try to open your mouth more and articulate vowel sounds clearly.');
    } else if (vowelClarity >= 80) {
      feedback.push('Excellent vowel clarity! Your articulation is very precise.');
    }
  }

  // =============================================
  // 3. Voice Quality (informational only, weight=0)
  // HNR/jitter/shimmer are clinical metrics designed for
  // sustained vowels in quiet rooms. Unreliable for
  // multi-syllable words through web microphones.
  // Still computed for diagnostic/debug purposes.
  // =============================================
  let voiceQuality = 70;
  if (raw.hnr > 0) {
    voiceQuality = Math.max(0, Math.min(100, Math.round((raw.hnr / 20) * 100)));
  }
  if (raw.jitter > 0.02) {
    voiceQuality = Math.max(10, voiceQuality - Math.round((raw.jitter - 0.02) * 800));
  }
  if (raw.shimmer > 0.08) {
    voiceQuality = Math.max(10, voiceQuality - Math.round((raw.shimmer - 0.08) * 300));
  }

  // =============================================
  // 4. Fluency (30%)
  // Speech rate for word repetition: 1-10 syllables/sec
  // Voiced fraction: even 3-5% is acceptable for single word tasks
  // =============================================
  let fluency = 70;
  if (raw.speechRate > 0) {
    // For word repetition: 1-10 syl/sec is normal range
    if (raw.speechRate >= 1 && raw.speechRate <= 10) {
      fluency = Math.min(100, Math.round(60 + (raw.speechRate - 1) * 4.5));
    } else if (raw.speechRate < 1) {
      fluency = Math.max(20, Math.round(raw.speechRate * 60));
      feedback.push('Try to speak a bit more continuously — avoid long pauses.');
    } else {
      fluency = Math.max(40, Math.round(100 - (raw.speechRate - 10) * 10));
      feedback.push('You might be speaking too fast — slow down slightly for clear pronunciation.');
    }
  }

  // Only penalize very low voiced fraction (< 3%)
  // In word repetition tasks, even 5-15% voiced is normal
  if (raw.voicedFraction < 0.03) {
    fluency = Math.max(0, fluency - 30);
    feedback.push('Most of your audio was silent — try speaking more confidently.');
  } else if (raw.voicedFraction < 0.1) {
    fluency = Math.max(20, fluency - 10);
  }

  // =============================================
  // Overall Score (weighted average)
  // =============================================
  const overall = Math.round(
    vowelClarity * 0.55 +
    fluency * 0.45
  );

  return {
    overall: Math.max(0, Math.min(100, overall)),
    pitchStability: Math.max(0, Math.min(100, pitchStability)),
    vowelClarity: Math.max(0, Math.min(100, vowelClarity)),
    voiceQuality: Math.max(0, Math.min(100, voiceQuality)),
    fluency: Math.max(0, Math.min(100, fluency)),
    details: raw,
    feedback: feedback.length > 0 ? feedback : ['Good pronunciation! Keep practicing.'],
  };
}

function createEmptyScore(message: string): PronunciationScore {
  return {
    overall: 0,
    pitchStability: 0,
    vowelClarity: 0,
    voiceQuality: 0,
    fluency: 0,
    details: {
      success: false,
      pitch: { mean: 0, min: 0, max: 0, stdev: 0 },
      formants: { f1_mean: 0, f2_mean: 0, f3_mean: 0 },
      intensity: { mean: 0, min: 0, max: 0, stdev: 0 },
      duration: 0,
      voicedFraction: 0,
      jitter: 0,
      shimmer: 0,
      hnr: 0,
      speechRate: 0,
    },
    feedback: [message],
  };
}

/**
 * Normalize a WAV buffer for playback:
 * 1. Low-pass filter (anti-aliasing before downsampling)
 * 2. Resample to 16kHz (consistent rate for both ref & user)
 * 3. Gentle peak-normalize loudness (capped gain to avoid amplifying noise)
 */
function normalizeWavForPlayback(wavBuffer: Buffer, originalRate: number): Buffer {
  const headerSize = 44;
  const targetRate = 16000;

  // Extract PCM data (skip WAV header)
  const pcmData = wavBuffer.slice(headerSize);
  const samples = new Int16Array(
    pcmData.buffer,
    pcmData.byteOffset,
    pcmData.length / 2
  );

  let resampled: Int16Array;

  if (originalRate !== targetRate) {
    // ── Step 1: Multi-pass low-pass filter to prevent aliasing ──
    // 2-pass with width=3 balances: static removal vs. speech clarity
    // (3-pass/width=5 was too aggressive — sounded muffled)
    const ratio = originalRate / targetRate;
    const filterWidth = 2;   // gentle window
    const PASSES = 2;        // 2 passes ≈ triangular rolloff

    let current = new Float64Array(samples.length);
    for (let i = 0; i < samples.length; i++) current[i] = samples[i];

    for (let pass = 0; pass < PASSES; pass++) {
      const next = new Float64Array(current.length);
      const half = Math.floor(filterWidth / 2);
      for (let i = 0; i < current.length; i++) {
        let sum = 0;
        let count = 0;
        const lo = Math.max(0, i - half);
        const hi = Math.min(current.length, i + half + 1);
        for (let j = lo; j < hi; j++) {
          sum += current[j];
          count++;
        }
        next[i] = sum / count;
      }
      current = next;
    }
    sdbg('audio', `[LPF] ${PASSES}-pass moving avg, width=${filterWidth}, ratio=${ratio.toFixed(2)}, inputSamples=${samples.length}`);

    // ── Step 2: Downsample with linear interpolation ──
    const newLen = Math.floor(samples.length / ratio);
    resampled = new Int16Array(newLen);
    for (let i = 0; i < newLen; i++) {
      const srcIdx = i * ratio;
      const lo = Math.floor(srcIdx);
      const hi = Math.min(lo + 1, samples.length - 1);
      const frac = srcIdx - lo;
      resampled[i] = Math.round(current[lo] * (1 - frac) + current[hi] * frac);
    }
  } else {
    resampled = new Int16Array(samples);
  }

  // ── Step 3: Gentle peak normalization ──
  // Cap gain at 3x to prevent amplifying noise/artifacts in quiet segments
  let maxAmp = 0;
  for (let i = 0; i < resampled.length; i++) {
    const a = Math.abs(resampled[i]);
    if (a > maxAmp) maxAmp = a;
  }

  const targetAmp = 25000; // ~76% of 32768 (conservative to avoid clipping)
  const MAX_GAIN = 3.0;    // never amplify more than 3x
  if (maxAmp > 0 && maxAmp < targetAmp) {
    const rawScale = targetAmp / maxAmp;
    const scale = Math.min(rawScale, MAX_GAIN);
    sdbg('audio', `Peak normalize: maxAmp=${maxAmp}, rawScale=${rawScale.toFixed(2)}, cappedScale=${scale.toFixed(2)}`);
    for (let i = 0; i < resampled.length; i++) {
      resampled[i] = Math.round(Math.max(-32768, Math.min(32767, resampled[i] * scale)));
    }
  }

  // Convert back to WAV
  const pcmBuf = Buffer.from(resampled.buffer, resampled.byteOffset, resampled.byteLength);
  return pcmToWav(pcmBuf, targetRate);
}

/**
 * Compare user pronunciation against AI reference audio
 */
export async function comparePronunciation(
  refBase64Chunks: string[],
  userBase64Chunks: string[],
  sampleRate: number = 16000,
  targetWord: string = ''
): Promise<ComparisonResult> {
  console.log(`[PraatService] 🔄 Comparing pronunciation — ref: ${refBase64Chunks.length} chunks, user: ${userBase64Chunks.length} chunks @ ${sampleRate}Hz — word: "${targetWord}"`);

  // Combine PCM chunks
  const rawRefPCM = Buffer.concat(refBase64Chunks.map(c => Buffer.from(c, 'base64')));
  const rawUserPCM = Buffer.concat(userBase64Chunks.map(c => Buffer.from(c, 'base64')));

  const AI_OUTPUT_RATE = 24000;
  console.log(`[PraatService] 📦 Raw — Ref: ${(rawRefPCM.length / 2 / AI_OUTPUT_RATE).toFixed(2)}s @24kHz | User: ${(rawUserPCM.length / 2 / sampleRate).toFixed(2)}s @${sampleRate}Hz`);

  // Check minimum length
  if (rawRefPCM.length < 4800 || rawUserPCM.length < 4800) {
    console.warn('[PraatService] ⚠️ Audio too short for comparison');
    return createEmptyComparison('Audio too short for comparison.');
  }

  // Convert to WAV (full audio first)
  const fullRefWav = pcmToWav(rawRefPCM, AI_OUTPUT_RATE);
  const fullUserWav = pcmToWav(rawUserPCM, sampleRate);

  const tmpDir = os.tmpdir();
  const ts = Date.now();
  const fullRefWavPath = path.join(tmpDir, `echomind_ref_full_${ts}.wav`);
  const fullUserWavPath = path.join(tmpDir, `echomind_user_full_${ts}.wav`);

  fs.writeFileSync(fullRefWavPath, fullRefWav);
  fs.writeFileSync(fullUserWavPath, fullUserWav);

  // ═══════════════════════════════════════════════
  // Whisper-based word alignment
  // Precisely locates target word in both audio files
  // ═══════════════════════════════════════════════
  let refWavPath = fullRefWavPath;
  let userWavPath = fullUserWavPath;

  if (targetWord) {
    console.log(`[Whisper] 🎯 Aligning "${targetWord}" in both audio files...`);

    // ── Pre-trim ref audio for Whisper ──
    // The ref chunks from frontend may still contain other words around the target.
    // Trimming silence helps Whisper focus on the speech portion.
    const trimmedRefPCM = trimSilence(rawRefPCM, AI_OUTPUT_RATE, 'ref-pre-whisper');
    const trimmedRefWav = pcmToWav(trimmedRefPCM, AI_OUTPUT_RATE);
    const trimmedRefWavPath = path.join(tmpDir, `echomind_ref_pretrimmed_${ts}.wav`);
    fs.writeFileSync(trimmedRefWavPath, trimmedRefWav);
    const refTrimmedDuration = (trimmedRefPCM.length / 2 / AI_OUTPUT_RATE).toFixed(2);
    const refFullDuration = (rawRefPCM.length / 2 / AI_OUTPUT_RATE).toFixed(2);
    console.log(`[Whisper] ✂️ Pre-trim ref: ${refFullDuration}s → ${refTrimmedDuration}s (removed ${(parseFloat(refFullDuration) - parseFloat(refTrimmedDuration)).toFixed(2)}s silence)`);

    // ── Pre-trim user audio for Whisper (Issue #010) ──
    // User buffer often has long leading silence (user thinking before speaking).
    // Whisper tiny struggles to find the target word in 25s audio that's mostly silence.
    // Solution: trim silence BEFORE sending to Whisper, so it only sees active speech (~5-6s).
    // The original fullUserWav is preserved for debug files.
    const trimmedUserPCM = trimSilence(rawUserPCM, sampleRate, 'user-pre-whisper');
    const trimmedUserWav = pcmToWav(trimmedUserPCM, sampleRate);
    const trimmedUserWavPath = path.join(tmpDir, `echomind_user_pretrimmed_${ts}.wav`);
    fs.writeFileSync(trimmedUserWavPath, trimmedUserWav);
    const trimmedDuration = (trimmedUserPCM.length / 2 / sampleRate).toFixed(2);
    const fullDuration = (rawUserPCM.length / 2 / sampleRate).toFixed(2);
    console.log(`[Whisper] ✂️ Pre-trim user: ${fullDuration}s → ${trimmedDuration}s (removed ${(parseFloat(fullDuration) - parseFloat(trimmedDuration)).toFixed(2)}s silence)`);

    // Run alignment on BOTH files in parallel
    // Both use hint to tell Whisper what word to expect
    // (AI synthetic speech is also hard for Whisper tiny to parse without a hint)
    const [refAlign, userAlign] = await Promise.all([
      whisperAlign(trimmedRefWavPath, targetWord, true),
      whisperAlign(trimmedUserWavPath, targetWord, true),
    ]);

    // Log what Whisper actually heard (helps debug failed alignments)
    if (refAlign.all_words) {
      const heard = refAlign.all_words.map((w) => w.word).join(' ');
      sdbg('audio', `[REF alignment] Whisper heard: "${heard}"`);
    }

    // Align ref — extract target word segment
    // Note: align.py already adds dynamic padding (150-600ms), no extra padding needed here
    // Timestamps are relative to the pre-trimmed WAV, so extract from trimmedRefWav
    if (refAlign.found && refAlign.start !== undefined && refAlign.end !== undefined) {
      sdbg('audio', `[REF alignment] Whisper found "${refAlign.word}" at ${refAlign.start}s-${refAlign.end}s (${(refAlign.end - refAlign.start).toFixed(3)}s) — extracting from trimmedRefWav (${trimmedRefWav.length} bytes, @${AI_OUTPUT_RATE}Hz)`);
      const refSeg = extractWavSegment(trimmedRefWav, AI_OUTPUT_RATE, refAlign.start, refAlign.end, 'REF');
      refWavPath = path.join(tmpDir, `echomind_ref_aligned_${ts}.wav`);
      fs.writeFileSync(refWavPath, refSeg);
      sdbg('audio', `[REF alignment] ✅ Aligned ref saved: ${refSeg.length} bytes → ${refWavPath}`);
      console.log(`[Whisper] ✅ Ref "${refAlign.word}" aligned: ${refAlign.start}s-${refAlign.end}s (${(refAlign.end - refAlign.start).toFixed(2)}s)`);
    } else {
      // Whisper still couldn't find the word — use trimmed ref instead of full ref
      sdbg('audio', `[REF alignment] ⚠️ Whisper did NOT find "${targetWord}" in ref — using trimmed ref audio (${trimmedRefWav.length} bytes)`);
      console.log(`[Whisper] ⚠️ Ref: word not found — using trimmed ref audio`);
      refWavPath = trimmedRefWavPath;
    }

    // Align user if possible — user speech may be unclear
    // Note: Whisper timestamps are relative to the pre-trimmed WAV,
    //        so we extract from trimmedUserWav (not fullUserWav)
    if (userAlign.found && userAlign.start !== undefined && userAlign.end !== undefined) {
      sdbg('audio', `[USER alignment] Whisper found "${userAlign.word}" at ${userAlign.start}s-${userAlign.end}s (${(userAlign.end - userAlign.start).toFixed(3)}s) — extracting from trimmedUserWav (${trimmedUserWav.length} bytes, @${sampleRate}Hz)`);
      const userSeg = extractWavSegment(trimmedUserWav, sampleRate, userAlign.start, userAlign.end, 'USER');
      userWavPath = path.join(tmpDir, `echomind_user_aligned_${ts}.wav`);
      fs.writeFileSync(userWavPath, userSeg);
      sdbg('audio', `[USER alignment] ✅ Aligned user saved: ${userSeg.length} bytes → ${userWavPath}`);
      console.log(`[Whisper] ✅ User "${userAlign.word}" aligned: ${userAlign.start}s-${userAlign.end}s (${(userAlign.end - userAlign.start).toFixed(2)}s)`);
    } else {
      // Whisper couldn't find even in trimmed audio — use the trimmed version as-is
      sdbg('audio', `[USER alignment] ⚠️ Whisper did NOT find "${targetWord}" — using pre-trimmed audio as fallback`);
      console.log(`[Whisper] ⚠️ User: word not recognized — using pre-trimmed audio (${trimmedDuration}s)`);
      userWavPath = trimmedUserWavPath;
    }

    // Clean up pre-trimmed temp files if they weren't used as the final paths
    if (userWavPath !== trimmedUserWavPath) {
      try { fs.unlinkSync(trimmedUserWavPath); } catch { }
    }
    if (refWavPath !== trimmedRefWavPath) {
      try { fs.unlinkSync(trimmedRefWavPath); } catch { }
    }
  }

  // Save debug copies (after alignment — normalized for fair playback comparison)
  const debugDir = path.join(process.cwd(), 'debug');
  if (!fs.existsSync(debugDir)) fs.mkdirSync(debugDir, { recursive: true });

  // Log WAV sizes before normalization (helps debug static audio issue)
  const refWavBuf = fs.readFileSync(refWavPath);
  const userWavBuf = fs.readFileSync(userWavPath);
  sdbg('audio', `Before normalize — ref: ${refWavBuf.length} bytes (${((refWavBuf.length - 44) / 2 / AI_OUTPUT_RATE).toFixed(3)}s @${AI_OUTPUT_RATE}Hz), user: ${userWavBuf.length} bytes (${((userWavBuf.length - 44) / 2 / sampleRate).toFixed(3)}s @${sampleRate}Hz)`);

  // Check if ref WAV has valid content (not mostly zeros)
  const refPcm = new Int16Array(refWavBuf.buffer, refWavBuf.byteOffset + 44, (refWavBuf.length - 44) / 2);
  let refMaxAmp = 0, refZeroCount = 0;
  for (let i = 0; i < refPcm.length; i++) {
    const a = Math.abs(refPcm[i]);
    if (a > refMaxAmp) refMaxAmp = a;
    if (a === 0) refZeroCount++;
  }
  const refZeroPct = ((refZeroCount / refPcm.length) * 100).toFixed(1);
  sdbg('audio', `Ref audio quality: maxAmp=${refMaxAmp}/32768, zeroPct=${refZeroPct}%, samples=${refPcm.length}`);
  if (refMaxAmp < 500) {
    console.warn(`[PraatService] ⚠️ REF AUDIO VERY QUIET: maxAmp=${refMaxAmp} — may sound like static!`);
  }
  if (parseFloat(refZeroPct) > 80) {
    console.warn(`[PraatService] ⚠️ REF AUDIO MOSTLY ZEROS: ${refZeroPct}% — extraction may have failed!`);
  }

  // Normalize both to 16kHz and peak-normalize loudness for fair playback comparison
  sdbg('audio', `[NORMALIZE] Starting ref normalization: ${refWavBuf.length} bytes @${AI_OUTPUT_RATE}Hz → 16kHz`);
  const refNorm = normalizeWavForPlayback(refWavBuf, AI_OUTPUT_RATE);
  sdbg('audio', `[NORMALIZE] Starting user normalization: ${userWavBuf.length} bytes @${sampleRate}Hz → 16kHz`);
  const userNorm = normalizeWavForPlayback(userWavBuf, sampleRate);

  // Analyze normalized output quality (detect static/clipping)
  const analyzeNormalized = (buf: Buffer, label: string) => {
    if (buf.length < 46) return;
    const pcm = new Int16Array(buf.buffer, buf.byteOffset + 44, (buf.length - 44) / 2);
    let maxA = 0, zeros = 0, sumSq = 0, jumps = 0;
    for (let i = 0; i < pcm.length; i++) {
      const a = Math.abs(pcm[i]);
      if (a > maxA) maxA = a;
      if (a === 0) zeros++;
      sumSq += pcm[i] * pcm[i];
      if (i > 0 && Math.abs(pcm[i] - pcm[i - 1]) > 15000) jumps++;
    }
    const rms = Math.sqrt(sumSq / pcm.length);
    const dur = (pcm.length / 16000).toFixed(3);
    sdbg('audio', `[NORMALIZE:${label}] Output: ${buf.length} bytes, ${pcm.length} samples, ${dur}s @16kHz`);
    sdbg('audio', `[NORMALIZE:${label}] Quality: maxAmp=${maxA}/32768 zeroPct=${((zeros / pcm.length) * 100).toFixed(1)}% RMS=${rms.toFixed(1)} largeJumps=${jumps}`);
    if (jumps > 100) {
      console.warn(`[PraatService] ⚠️ ${label}_recording.wav has ${jumps} large jumps — likely STATIC/NOISE!`);
    }
    if (maxA >= 32768) {
      console.warn(`[PraatService] ⚠️ ${label}_recording.wav CLIPPING detected (maxAmp=${maxA})!`);
    }
  };
  analyzeNormalized(refNorm, 'REF');
  analyzeNormalized(userNorm, 'USER');

  fs.writeFileSync(path.join(debugDir, 'ref_recording.wav'), refNorm);
  fs.writeFileSync(path.join(debugDir, 'user_recording.wav'), userNorm);

  // Save normalized WAVs to temp for forced alignment + Praat vowel queries
  // (must use normalized 16kHz versions for consistent formant analysis)
  const normRefWavPath = path.join(tmpDir, `echomind_ref_norm_${ts}.wav`);
  const normUserWavPath = path.join(tmpDir, `echomind_user_norm_${ts}.wav`);
  fs.writeFileSync(normRefWavPath, refNorm);
  fs.writeFileSync(normUserWavPath, userNorm);

  // Also save full (pre-alignment) copies for inspection
  fs.copyFileSync(fullRefWavPath, path.join(debugDir, 'ref_full.wav'));
  fs.copyFileSync(fullUserWavPath, path.join(debugDir, 'user_full.wav'));
  console.log(`[PraatService] 🐛 Debug files saved to ${debugDir}`);
  sdbg('audio', `[DEBUG FILES] ref_full.wav=${fullRefWav.length}B, ref_recording.wav=${refNorm.length}B, user_full.wav=${fullUserWav.length}B, user_recording.wav=${userNorm.length}B`);

  // Phoneme analysis output path
  const phonemeOutputPath = path.join(debugDir, 'phoneme_user.json');

  try {
    console.log('[PraatService] 🔬 Running Praat + MFCC-DTW + wav2vec2 comparison...');
    const startTime = Date.now();

    // Run Praat, MFCC-DTW, and wav2vec2 phoneme analysis ALL in parallel
    const [praatResult, dtwResult, phonemeResult] = await Promise.all([
      // Praat: pitch, formant, intensity, duration
      new Promise<any>((resolve, reject) => {
        execFile(
          PRAAT_EXE,
          ['--run', '--utf8', PRAAT_COMPARE_SCRIPT, refWavPath, userWavPath],
          { timeout: 30000, maxBuffer: 1024 * 512 },
          (error, stdout, stderr) => {
            if (error) {
              console.error('[PraatService] Compare error:', error.message);
              reject(error);
              return;
            }
            try {
              resolve(JSON.parse(stdout.toString().trim()));
            } catch (e) {
              console.error('[PraatService] Failed to parse compare output:', stdout);
              reject(e);
            }
          }
        );
      }),
      // Python MFCC-DTW: spectral similarity distance
      new Promise<any>((resolve) => {
        execFile(
          PYTHON_EXE, [MFCC_DTW_SCRIPT, refWavPath, userWavPath],
          { timeout: 30000, maxBuffer: 1024 * 512 },
          (error, stdout) => {
            if (error) {
              console.warn('[PraatService] ⚠️ MFCC-DTW failed:', error.message);
              resolve({ distance: 999 });
              return;
            }
            try {
              resolve(JSON.parse(stdout.toString().trim()));
            } catch {
              resolve({ distance: 999 });
            }
          }
        );
      }),
      // wav2vec2 phoneme analysis: per-character probabilities
      new Promise<any>((resolve) => {
        if (!targetWord) { resolve(null); return; }
        execFile(
          PYTHON_EXE, [PHONEME_SCRIPT, userWavPath, targetWord, '--output', phonemeOutputPath],
          { timeout: 60000, maxBuffer: 1024 * 1024 },
          (error, stdout) => {
            if (error) {
              console.warn(`[wav2vec2] ⚠️ Phoneme analysis failed: ${error.message}`);
              resolve(null);
              return;
            }
            try {
              const result = JSON.parse(stdout.toString().trim());
              console.log(`[wav2vec2] ✅ Recognized: "${result.recognized_text}" | Chars: ${result.phoneme_count} | Accuracy: ${result.char_accuracy?.similarity ?? 'N/A'}%`);
              resolve(result);
            } catch {
              console.warn('[wav2vec2] ⚠️ Failed to parse output');
              resolve(null);
            }
          }
        );
      }),
    ]);

    // Merge DTW distance into Praat result
    const result = { ...praatResult, dtwDistance: dtwResult.distance ?? 999 };

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`[PraatService] ✅ Comparison completed in ${elapsed}s`);
    console.log(`[PraatService] 📊 MFCC-DTW distance: ${result.dtwDistance}`);
    console.log(`[PraatService] 📊 Pitch correlation: ${result.pitchCorrelation}`);
    console.log(`[PraatService] 📊 Duration ratio: ${result.durationRatio}`);
    console.log(`[PraatService] 📊 F1 similarity: ${result.f1Similarity}% | F2 similarity: ${result.f2Similarity}%`);
    console.log(`[PraatService] 📊 Intensity correlation: ${result.intensityCorrelation}`);
    if (phonemeResult) {
      console.log(`[PraatService] 📊 wav2vec2 phonemes: "${phonemeResult.recognized_text}" (${phonemeResult.char_accuracy?.similarity ?? 0}% accuracy)`);
    }

    const comparison = await computeComparison(result, phonemeResult, normRefWavPath, normUserWavPath, targetWord);
    // Attach phoneme analysis to comparison result (if available)
    if (phonemeResult) {
      (comparison as any).phonemeAnalysis = {
        recognized: phonemeResult.recognized_text,
        charSegments: phonemeResult.char_segments,
        charAccuracy: phonemeResult.char_accuracy,
        audioDuration: phonemeResult.audio_duration,
        wordTip: phonemeResult.word_tip || null,
        syllableBreakdown: phonemeResult.syllable_breakdown || null,
      };
    }
    return comparison;
  } catch (err) {
    console.error('[PraatService] ❌ Comparison failed:', err);
    return createEmptyComparison('Comparison failed.');
  } finally {
    // Clean up all temp files
    for (const f of [refWavPath, userWavPath, fullRefWavPath, fullUserWavPath]) {
      try { fs.unlinkSync(f); } catch { }
    }
  }
}

// ── ARPAbet vowel reference: familiar words + typical F1/F2 ──
const VOWEL_REFERENCE: Record<string, { sound: string; example: string; word: string; f1: number; f2: number }> = {
  'AA': { sound: 'ah', example: 'father', word: 'f-ah-ther', f1: 730, f2: 1090 },
  'AE': { sound: 'a',  example: 'cat',    word: 'c-a-t',     f1: 660, f2: 1720 },
  'AH': { sound: 'uh', example: 'but',    word: 'b-uh-t',    f1: 520, f2: 1190 },
  'AO': { sound: 'aw', example: 'call',   word: 'c-aw-l',    f1: 570, f2: 840 },
  'AW': { sound: 'ow', example: 'now',    word: 'n-ow',      f1: 700, f2: 1100 },
  'AY': { sound: 'ai', example: 'my',     word: 'm-eye',     f1: 700, f2: 1200 },
  'EH': { sound: 'eh', example: 'bed',    word: 'b-eh-d',    f1: 530, f2: 1840 },
  'ER': { sound: 'ur', example: 'bird',   word: 'b-ur-d',    f1: 490, f2: 1350 },
  'EY': { sound: 'ay', example: 'say',    word: 's-ay',      f1: 420, f2: 2020 },
  'IH': { sound: 'ih', example: 'sit',    word: 's-ih-t',    f1: 390, f2: 1990 },
  'IY': { sound: 'ee', example: 'see',    word: 's-ee',      f1: 270, f2: 2290 },
  'OW': { sound: 'oh', example: 'go',     word: 'g-oh',      f1: 500, f2: 910 },
  'OY': { sound: 'oy', example: 'boy',    word: 'b-oy',      f1: 570, f2: 840 },
  'UH': { sound: 'uh', example: 'book',   word: 'b-oo-k',    f1: 440, f2: 1020 },
  'UW': { sound: 'oo', example: 'food',   word: 'f-oo-d',    f1: 300, f2: 870 },
};

// ARPAbet vowels set for quick lookup
const ARPABET_VOWELS = new Set(Object.keys(VOWEL_REFERENCE));

// ── Forced Alignment types ──

interface VowelTimeRange {
  phoneme: string;
  start: number;
  end: number;
  syllable_index: number;
}

interface ForcedAlignResult {
  word: string;
  phonemes: { phoneme: string; start: number; end: number; is_vowel: boolean }[];
  vowels: VowelTimeRange[];
}

interface VowelFormantResult {
  f1: number;
  f2: number;
  time: number;
  int: number;
}

// ── Alignment Server management ──
const ALIGN_SERVER_PORT = 5050;
const ALIGN_SERVER_URL = `http://127.0.0.1:${ALIGN_SERVER_PORT}`;
const ALIGN_SERVER_SCRIPT = path.join(process.cwd(), 'scripts', 'align_server.py');
import http from 'http';
import { spawn, ChildProcess } from 'child_process';

let alignServerProcess: ChildProcess | null = null;
let alignServerReady = false;
let alignServerStarting: Promise<boolean> | null = null;

/**
 * Ensure the alignment server is running. Auto-starts if needed.
 */
async function ensureAlignServer(): Promise<boolean> {
  // Quick health check
  if (alignServerReady) {
    try {
      const ok = await httpGet(`${ALIGN_SERVER_URL}/health`);
      if (ok) return true;
    } catch { /* server died, restart */ }
    alignServerReady = false;
  }

  // Try connecting to existing server
  try {
    const ok = await httpGet(`${ALIGN_SERVER_URL}/health`);
    if (ok) { alignServerReady = true; return true; }
  } catch { /* not running */ }

  // If already starting (e.g. parallel call), wait for that
  if (alignServerStarting) return alignServerStarting;

  // Start server
  console.log(`[AlignServer] Starting alignment server...`);
  alignServerStarting = new Promise((resolve) => {
    const proc = spawn(PYTHON_EXE, [ALIGN_SERVER_SCRIPT, String(ALIGN_SERVER_PORT)], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    alignServerProcess = proc;

    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved) { resolved = true; resolve(false); }
    }, 120000); // 2 min timeout for model download + load

    const onData = (data: Buffer) => {
      const text = data.toString();
      process.stdout.write(`[AlignServer] ${text}`);
      if (text.includes('READY') && !resolved) {
        resolved = true;
        alignServerReady = true;
        clearTimeout(timeout);
        console.log(`[AlignServer] ✅ Server ready on port ${ALIGN_SERVER_PORT}`);
        resolve(true);
      }
    };
    proc.stdout?.on('data', onData);
    proc.stderr?.on('data', onData);

    proc.on('exit', (code) => {
      console.log(`[AlignServer] Process exited with code ${code}`);
      alignServerReady = false;
      alignServerProcess = null;
      alignServerStarting = null;
      if (!resolved) { resolved = true; resolve(false); }
    });

    proc.unref(); // Don't prevent Node from exiting
  });
  return alignServerStarting;
}

function httpGet(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 2000 }, (res) => {
      let body = '';
      res.on('data', (d) => body += d);
      res.on('end', () => resolve(res.statusCode === 200));
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function httpPost(url: string, data: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const parsed = new URL(url);
    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 30000,
    }, (res) => {
      let responseBody = '';
      res.on('data', (d) => responseBody += d);
      res.on('end', () => {
        try { resolve(JSON.parse(responseBody)); }
        catch { reject(new Error(`Invalid JSON: ${responseBody}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(body);
    req.end();
  });
}

/**
 * Locate target word in wav2vec2 char_segments using fuzzy matching.
 * Returns {start, end} in seconds or null if not found.
 */
function locateWordInCharSegments(charSegments: any[], targetWord: string): { start: number; end: number } | null {
  if (!charSegments || charSegments.length === 0) return null;

  // Build the full recognized text with segment indices for each character
  const chars: { char: string; segIdx: number }[] = [];
  for (let i = 0; i < charSegments.length; i++) {
    const seg = charSegments[i];
    if (seg.char === '|') {
      chars.push({ char: ' ', segIdx: i });
    } else {
      for (const c of seg.char) {
        chars.push({ char: c, segIdx: i });
      }
    }
  }

  const fullText = chars.map(c => c.char).join('');
  const target = targetWord.toUpperCase();

  // Try exact match first
  let matchStart = fullText.indexOf(target);

  // Try fuzzy: find best substring match
  if (matchStart < 0) {
    let bestScore = 0;
    let bestPos = -1;
    for (let pos = 0; pos <= fullText.length - Math.floor(target.length * 0.5); pos++) {
      for (let len = Math.floor(target.length * 0.6); len <= Math.min(target.length * 1.5, fullText.length - pos); len++) {
        const sub = fullText.substring(pos, pos + len);
        let matches = 0;
        const minLen = Math.min(sub.length, target.length);
        for (let i = 0; i < minLen; i++) {
          if (sub[i] === target[i]) matches++;
        }
        const score = matches / Math.max(sub.length, target.length);
        if (score > bestScore && score > 0.4) {
          bestScore = score;
          bestPos = pos;
        }
      }
    }
    if (bestPos >= 0) matchStart = bestPos;
  }

  if (matchStart < 0) return null;

  // Find the segment indices for the match
  const startSegIdx = chars[matchStart].segIdx;
  const endCharIdx = Math.min(matchStart + target.length - 1, chars.length - 1);
  const endSegIdx = chars[endCharIdx].segIdx;

  const start = charSegments[startSegIdx].start;
  const end = charSegments[endSegIdx].end;

  return { start, end };
}

/**
 * Run MMS forced alignment via the alignment server.
 * Auto-starts server if needed. Returns vowel time ranges.
 * hint_start/hint_end: optional timing from wav2vec2 to narrow the search window.
 */
async function runForcedAlignment(wavPath: string, word: string, phonemes: string[], hintStart?: number, hintEnd?: number): Promise<ForcedAlignResult | null> {
  try {
    const serverOk = await ensureAlignServer();
    if (!serverOk) {
      console.error(`[PraatService] Alignment server not available`);
      return null;
    }

    const payload: any = { wav_path: wavPath, word, phonemes };
    if (hintStart !== undefined && hintEnd !== undefined) {
      payload.hint_start = hintStart;
      payload.hint_end = hintEnd;
    }
    const result = await httpPost(`${ALIGN_SERVER_URL}/align`, payload);

    if (result.error) {
      console.error(`[PraatService] Alignment error:`, result.error);
      return null;
    }

    console.log(`[PraatService] 🎯 Aligned ${word}: ${result.vowels.length} vowels`);
    for (const v of result.vowels) {
      console.log(`[PraatService]   ${v.phoneme}: ${v.start.toFixed(3)}-${v.end.toFixed(3)}s`);
    }
    return result;
  } catch (e: any) {
    console.error(`[PraatService] Forced alignment failed:`, e.message);
    return null;
  }
}

/**
 * Query Praat for F1/F2 at intensity peaks within given vowel time ranges.
 * Returns one result per vowel range.
 */
async function queryVowelFormants(wavPath: string, vowelRanges: VowelTimeRange[]): Promise<VowelFormantResult[]> {
  if (vowelRanges.length === 0) return [];
  const starts = vowelRanges.map(v => v.start.toFixed(4)).join(',');
  const ends = vowelRanges.map(v => v.end.toFixed(4)).join(',');
  
  return new Promise((resolve) => {
    execFile(PRAAT_EXE, ['--run', '--utf8', QUERY_VOWELS_SCRIPT, wavPath, starts, ends], {
      timeout: 15000,
    }, (error, stdout, stderr) => {
      if (error) {
        console.error(`[PraatService] queryVowelFormants failed:`, error.message);
        resolve(vowelRanges.map(() => ({ f1: 0, f2: 0, time: 0, int: 0 })));
        return;
      }
      try {
        const results = JSON.parse(stdout.trim());
        resolve(results);
      } catch (e) {
        console.error(`[PraatService] queryVowelFormants parse error:`, e);
        resolve(vowelRanges.map(() => ({ f1: 0, f2: 0, time: 0, int: 0 })));
      }
    });
  });
}


const GT_SCRIPT = path.join(process.cwd(), 'praat', 'ground_truth.praat');
const VALIDATION_LOG = path.join(process.cwd(), 'debug', 'f1f2_validation_log.json');

/**
 * Auto-validate F1/F2: compare pipeline output with Praat ground truth.
 * Runs in background after each analysis. Results appended to validation log.
 */
async function autoValidateFormants(
  word: string,
  refWavPath: string, userWavPath: string,
  refVowels: VowelTimeRange[], userVowels: VowelTimeRange[],
  pipeRef: VowelFormantResult[], pipeUser: VowelFormantResult[],
  vowelNames: string[]
): Promise<void> {
  try {
    const queryGT = (wavPath: string, vowels: VowelTimeRange[]): Promise<any[]> => {
      const starts = vowels.map(v => v.start.toFixed(4)).join(',');
      const ends = vowels.map(v => v.end.toFixed(4)).join(',');
      return new Promise((resolve) => {
        execFile(PRAAT_EXE, ['--run', '--utf8', GT_SCRIPT, wavPath, starts, ends], {
          timeout: 15000,
        }, (error, stdout) => {
          if (error) { resolve([]); return; }
          try { resolve(JSON.parse(stdout.trim())); }
          catch { resolve([]); }
        });
      });
    };

    const [gtRef, gtUser] = await Promise.all([
      queryGT(refWavPath, refVowels),
      queryGT(userWavPath, userVowels),
    ]);

    if (!gtUser.length || !pipeUser.length) return;

    const vowels: any[] = [];
    let good = 0, ok = 0, bad = 0;
    for (let i = 0; i < Math.min(vowelNames.length, pipeUser.length, gtUser.length); i++) {
      const pu = pipeUser[i];
      const gu = gtUser[i];
      const f1d = Math.abs(pu.f1 - gu.mid.f1);
      const f2d = Math.abs(pu.f2 - gu.mid.f2);
      const status = (f1d < 50 && f2d < 50) ? 'GOOD' : (f1d < 100 && f2d < 100) ? 'OK' : 'BAD';
      if (status === 'GOOD') good++; else if (status === 'OK') ok++; else bad++;
      vowels.push({
        vowel: vowelNames[i], status,
        pipe_f1: Math.round(pu.f1), pipe_f2: Math.round(pu.f2),
        gt_f1: Math.round(gu.mid.f1), gt_f2: Math.round(gu.mid.f2),
        f1d: Math.round(f1d), f2d: Math.round(f2d),
      });
    }

    const total = good + ok + bad;
    const entry = {
      timestamp: new Date().toISOString(),
      word,
      vowels,
      summary: { total, good, ok, bad, accuracy: total > 0 ? Math.round(good / total * 100) : 0 },
    };

    // Log to console
    const statusLine = vowels.map((v: any) => `${v.vowel}:${v.status}(dF1=${v.f1d},dF2=${v.f2d})`).join(' ');
    console.log(`[F1F2-Test] ${word} → ${statusLine} | Accuracy: ${entry.summary.accuracy}%`);

    // Append to validation log
    let log: any[] = [];
    try {
      if (fs.existsSync(VALIDATION_LOG)) {
        log = JSON.parse(fs.readFileSync(VALIDATION_LOG, 'utf-8'));
      }
    } catch {}
    log.push(entry);
    fs.writeFileSync(VALIDATION_LOG, JSON.stringify(log, null, 2));
  } catch {}
}

async function analyzeVowelsPerSyllable(raw: any, phonemeData: any, refWavPath?: string, userWavPath?: string, word?: string): Promise<VowelAnalysis[]> {
  const formantTrack = raw.formantTrack;
  if (!formantTrack || !phonemeData?.char_accuracy?.syllables || !phonemeData?.char_accuracy?.phonemes_arpabet) {
    return [];
  }

  const syllables: string[] = phonemeData.char_accuracy.syllables;
  const phonemes: string[] = phonemeData.char_accuracy.phonemes_arpabet;
  const stressSyllable: number = phonemeData.char_accuracy.stress_syllable ?? -1;
  const numSyllables = syllables.length;
  if (numSyllables === 0) return [];

  // Map phonemes to syllables to find each syllable's vowel
  const syllableVowels: string[] = [];
  let phonemePtr = 0;
  for (let si = 0; si < numSyllables; si++) {
    let foundVowel = '';
    const remaining = numSyllables - si;
    const remainingPhonemes = phonemes.length - phonemePtr;
    const phonemesForSyl = Math.max(1, Math.round(remainingPhonemes / remaining));
    for (let pi = 0; pi < phonemesForSyl && phonemePtr < phonemes.length; pi++, phonemePtr++) {
      if (ARPABET_VOWELS.has(phonemes[phonemePtr]) && !foundVowel) foundVowel = phonemes[phonemePtr];
    }
    syllableVowels.push(foundVowel || 'AH');
  }

  // ── Try forced alignment (MMS) for precise vowel positions ──
  let refFormants: VowelFormantResult[] | null = null;
  let userFormants: VowelFormantResult[] | null = null;

  if (refWavPath && userWavPath && word) {
    try {
      // Check audio durations for logging
      const refStat = fs.statSync(refWavPath);
      const userStat = fs.statSync(userWavPath);
      const refDuration = (refStat.size - 44) / 2 / 16000;  // 16kHz 16-bit mono
      const userDuration = (userStat.size - 44) / 2 / 16000;
      const durationRatio = userDuration / Math.max(0.1, refDuration);

      console.log(`[PraatService] 🧠 Running forced alignment for "${word}" (ref=${refDuration.toFixed(1)}s, user=${userDuration.toFixed(1)}s, ratio=${durationRatio.toFixed(1)}x)...`);

      // Try to locate target word in wav2vec2's char_segments for user audio
      let userHintStart: number | undefined;
      let userHintEnd: number | undefined;
      if (phonemeData?.char_segments) {
        const loc = locateWordInCharSegments(phonemeData.char_segments, word);
        if (loc) {
          userHintStart = loc.start;
          userHintEnd = loc.end;
          console.log(`[PraatService] 📍 wav2vec2 located "${word}" at ${loc.start.toFixed(2)}s-${loc.end.toFixed(2)}s`);
        }
      }

      const [refAlign, userAlign] = await Promise.all([
        runForcedAlignment(refWavPath, word, phonemes),
        runForcedAlignment(userWavPath, word, phonemes, userHintStart, userHintEnd),
      ]);

      if (refAlign?.vowels?.length && userAlign?.vowels?.length) {
        // Query Praat for F1/F2 at intensity peaks within each vowel range
        [refFormants, userFormants] = await Promise.all([
          queryVowelFormants(refWavPath, refAlign.vowels),
          queryVowelFormants(userWavPath, userAlign.vowels),
        ]);
        console.log(`[PraatService] ✅ Forced alignment + Praat query complete`);

        // ── Auto F1/F2 ground truth validation (background, non-blocking) ──
        autoValidateFormants(word, refWavPath!, userWavPath!, refAlign.vowels, userAlign.vowels, refFormants, userFormants, syllableVowels).catch(() => {});
      }
    } catch (e) {
      console.error(`[PraatService] Forced alignment error, falling back:`, e);
    }
  }

  // ── Build per-syllable results ──
  const results: VowelAnalysis[] = [];

  for (let si = 0; si < numSyllables; si++) {
    let avgRefF1 = 0, avgRefF2 = 0, avgUserF1 = 0, avgUserF2 = 0;

    if (refFormants && userFormants && si < refFormants.length && si < userFormants.length) {
      // Use forced-alignment-based formants
      avgRefF1 = refFormants[si].f1;
      avgRefF2 = refFormants[si].f2;
      avgUserF1 = userFormants[si].f1;
      avgUserF2 = userFormants[si].f2;
      console.log(`[PraatService] 🎯 Syl${si + 1} [${syllableVowels[si]}] ref@${refFormants[si].time.toFixed(3)}s F1=${avgRefF1.toFixed(0)} F2=${avgRefF2.toFixed(0)} | user@${userFormants[si].time.toFixed(3)}s F1=${avgUserF1.toFixed(0)} F2=${avgUserF2.toFixed(0)}`);
    } else {
      // Fallback: use formant track bins (old approach)
      const refF1: number[] = formantTrack.refF1 || [];
      const refInt: number[] = formantTrack.refInt || [];
      const userF1t: number[] = formantTrack.userF1 || [];
      const userInt: number[] = formantTrack.userInt || [];
      const trackLen = refF1.length;
      if (trackLen > 0) {
        const binStart = Math.floor(si / numSyllables * trackLen);
        const binEnd = Math.floor((si + 1) / numSyllables * trackLen);
        let bestRefInt = 0, bestUserInt = 0;
        for (let i = binStart; i < binEnd && i < trackLen; i++) {
          if (refInt[i] > bestRefInt && refF1[i] > 100) {
            bestRefInt = refInt[i];
            avgRefF1 = refF1[i]; avgRefF2 = (formantTrack.refF2 || [])[i] || 0;
          }
          if (userInt[i] > bestUserInt && userF1t[i] > 100) {
            bestUserInt = userInt[i];
            avgUserF1 = userF1t[i]; avgUserF2 = (formantTrack.userF2 || [])[i] || 0;
          }
        }
      }
    }

    // Skip syllable if either ref or user has no voiced data at all
    const hasData = avgRefF1 > 0 && avgUserF1 > 0;

    // Compute per-syllable similarity using Bark scale (perceptual frequency)
    // Bark = 26.81 / (1 + 1960/f) - 0.53
    const toBark = (f: number) => 26.81 / (1 + 1960 / f) - 0.53;
    const refF1Bark = avgRefF1 > 0 ? toBark(avgRefF1) : 0;
    const refF2Bark = avgRefF2 > 0 ? toBark(avgRefF2) : 0;
    const userF1Bark = avgUserF1 > 0 ? toBark(avgUserF1) : 0;
    const userF2Bark = avgUserF2 > 0 ? toBark(avgUserF2) : 0;
    const f1BarkDiff = Math.abs(refF1Bark - userF1Bark);
    const f2BarkDiff = Math.abs(refF2Bark - userF2Bark);
    const f1Sim = hasData
      ? Math.round(Math.exp(-f1BarkDiff / 1.5) * 100)  // 1.5 Bark ≈ 200Hz at F1 range
      : -1;  // -1 = no data (skipped)
    const f2Sim = hasData
      ? Math.round(Math.exp(-f2BarkDiff / 2.0) * 100)  // 2.0 Bark ≈ 300Hz at F2 range
      : -1;
    const overallMatch = hasData ? Math.round((f1Sim + f2Sim) / 2) : -1;

    // Determine direction of mismatch
    const f1Dir: 'ok' | 'too_open' | 'too_closed' =
      !hasData || f1Sim >= 70 ? 'ok' :
      avgUserF1 > avgRefF1 ? 'too_open' : 'too_closed';
    const f2Dir: 'ok' | 'too_front' | 'too_back' =
      !hasData || f2Sim >= 70 ? 'ok' :
      avgUserF2 > avgRefF2 ? 'too_front' : 'too_back';

    // Generate tip with reference word
    const vowelKey = syllableVowels[si];
    const vRef = VOWEL_REFERENCE[vowelKey] || { sound: 'uh', example: 'but', word: 'b-uh-t' };
    let tip = '';
    if (!hasData) {
      tip = `(Skipped — not enough voiced data to compare)`;
    } else if (f1Sim >= 70 && f2Sim >= 70) {
      tip = `Great! Sounds like "${vRef.sound}" in ${vRef.example} ✓`;
    } else if (f1Dir === 'too_closed' && f2Dir === 'ok') {
      tip = `This should sound like "${vRef.sound}" in ${vRef.example} — open your mouth wider`;
    } else if (f1Dir === 'too_open' && f2Dir === 'ok') {
      tip = `This should sound like "${vRef.sound}" in ${vRef.example} — close your mouth a bit more`;
    } else if (f2Dir === 'too_back' && f1Dir === 'ok') {
      tip = `This should sound like "${vRef.sound}" in ${vRef.example} — move your tongue forward`;
    } else if (f2Dir === 'too_front' && f1Dir === 'ok') {
      tip = `This should sound like "${vRef.sound}" in ${vRef.example} — pull your tongue back a bit`;
    } else if (f1Dir === 'too_closed' && f2Dir === 'too_back') {
      tip = `This should sound like "${vRef.sound}" in ${vRef.example} — open wider and tongue forward`;
    } else {
      tip = `This should sound like "${vRef.sound}" in ${vRef.example} — adjust your mouth shape`;
    }

    results.push({
      syllableIndex: si,
      syllable: syllables[si],
      isStressed: stressSyllable === si + 1,
      vowel: vowelKey,
      refF1: Math.round(avgRefF1),
      refF2: Math.round(avgRefF2),
      userF1: Math.round(avgUserF1),
      userF2: Math.round(avgUserF2),
      f1Similarity: Math.max(0, f1Sim),  // -1 → 0 for output
      f2Similarity: Math.max(0, f2Sim),
      overallMatch: Math.max(0, overallMatch),
      f1Direction: f1Dir,
      f2Direction: f2Dir,
      tip,
    });
  }

  return results;
}

async function computeComparison(raw: any, phonemeData?: any, refWavPath?: string, userWavPath?: string, targetWord?: string): Promise<ComparisonResult> {
  const feedback: string[] = [];

  // ── MFCC-DTW distance → score (45% weight — core "does it sound like the same word?") ──
  const dtwDist = raw.dtwDistance ?? 999;
  const mfccScore = dtwDist < 900 ? Math.max(0, Math.round(100 * Math.exp(-dtwDist / 25))) : 0;
  console.log(`[PraatService] 📊 MFCC-DTW: dist=${dtwDist.toFixed(2)} → score=${mfccScore}/100`);

  if (mfccScore >= 70) {
    feedback.push('Excellent overall pronunciation — sounds very close to the reference!');
  } else if (mfccScore >= 40) {
    feedback.push('Your pronunciation is recognizable but differs from the reference — keep practicing!');
  } else {
    feedback.push('Your pronunciation sounds quite different — try to mimic the reference more closely.');
  }

  // ── Pitch contour similarity (5% weight) ──
  const pitchScore = Math.max(0, raw.pitchCorrelation * 100);
  if (pitchScore >= 80) {
    feedback.push('Great intonation! Your pitch pattern closely matches the reference.');
  }

  // ── Duration similarity (15% weight — ASYMMETRIC) ──
  const durRatio = raw.durationRatio;
  let durScore: number;
  if (durRatio >= 0.7 && durRatio <= 1.5) {
    durScore = 100;
  } else if (durRatio > 1.5 && durRatio <= 3.0) {
    durScore = Math.max(60, Math.round(100 - (durRatio - 1.5) * 26));
  } else if (durRatio >= 0.4 && durRatio < 0.7) {
    durScore = Math.max(30, Math.round(100 - (0.7 - durRatio) * 230));
  } else if (durRatio > 3.0) {
    durScore = 50;
  } else {
    durScore = Math.max(0, Math.round(30 - (0.4 - durRatio) * 100));
  }

  if (durRatio < 0.5) {
    feedback.push('You spoke much faster than the reference — slow down to pronounce each syllable clearly.');
  } else if (durRatio > 2.5) {
    feedback.push('You spoke quite slowly — that\'s fine for practice, try to gradually speed up.');
  }

  // ── Per-syllable vowel analysis ──
  const vowelAnalysis = await analyzeVowelsPerSyllable(raw, phonemeData, refWavPath, userWavPath, targetWord);
  
  // ── Formant similarity (30% weight — now per-syllable if available) ──
  let formantScore: number;
  if (vowelAnalysis.length > 0) {
    // Only average syllables with actual voiced data (skip those with overallMatch=0)
    const validSyllables = vowelAnalysis.filter(v => v.overallMatch > 0);
    if (validSyllables.length > 0) {
      formantScore = Math.round(
        validSyllables.reduce((sum, v) => sum + v.overallMatch, 0) / validSyllables.length
      );
    } else {
      formantScore = (raw.f1Similarity + raw.f2Similarity) / 2;
    }
    // Log per-syllable results
    vowelAnalysis.forEach(v => {
      const marker = v.isStressed ? '★' : ' ';
      const skip = v.overallMatch === 0 ? ' [SKIP]' : '';
      console.log(`[PraatService] 🔤 Syl${v.syllableIndex + 1}${marker} [${v.vowel}]: Mouth=${v.f1Similarity}% Tongue=${v.f2Similarity}% → ${v.overallMatch}%${skip}  (ref F1=${v.refF1}Hz F2=${v.refF2}Hz | user F1=${v.userF1}Hz F2=${v.userF2}Hz)`);
    });
    // Add feedback for worst syllable WITH data
    const worstWithData = validSyllables.length > 0
      ? validSyllables.reduce((a, b) => a.overallMatch < b.overallMatch ? a : b)
      : null;
    if (worstWithData && worstWithData.overallMatch < 50) {
      feedback.push(worstWithData.tip);
    }
  } else {
    // Fallback to whole-word average
    formantScore = (raw.f1Similarity + raw.f2Similarity) / 2;
  }

  if (formantScore >= 70) {
    feedback.push('Excellent vowel quality — your pronunciation sounds very natural!');
  } else if (formantScore < 40) {
    feedback.push('Your vowel sounds differ — try to adjust your mouth position.');
  }

  // ── Intensity similarity (5% weight) ──
  const intensityScore = Math.max(0, raw.intensityCorrelation * 100);

  // ── Overall weighted similarity ──
  const overallSimilarity = Math.round(
    mfccScore * 0.35 +
    pitchScore * 0.15 +
    durScore * 0.15 +
    formantScore * 0.30 +
    intensityScore * 0.05
  );

  console.log(`[PraatService] 🏆 Comparison scores → Overall: ${Math.max(0, Math.min(100, overallSimilarity))} | MFCC: ${mfccScore} | Pitch: ${Math.round(pitchScore)} | Duration: ${durScore} | Formant: ${Math.round(formantScore)} | Intensity: ${Math.round(intensityScore)}`);

  return {
    pitchCorrelation: raw.pitchCorrelation,
    durationRatio: raw.durationRatio,
    f1Similarity: raw.f1Similarity,
    f2Similarity: raw.f2Similarity,
    intensityCorrelation: raw.intensityCorrelation,
    overallSimilarity: Math.max(0, Math.min(100, overallSimilarity)),
    mfccScore: Math.round(mfccScore),
    pitchScore: Math.round(pitchScore),
    durationScore: Math.round(durScore),
    formantScore: Math.round(formantScore),
    intensityScore: Math.round(intensityScore),
    ref: raw.ref,
    user: raw.user,
    pitchContour: raw.pitchContour,
    vowelAnalysis: vowelAnalysis.length > 0 ? vowelAnalysis : undefined,
    feedback,
    audioTimestamp: Date.now(),
  };
}

function createEmptyComparison(message: string): ComparisonResult {
  return {
    pitchCorrelation: 0,
    durationRatio: 0,
    f1Similarity: 0,
    f2Similarity: 0,
    intensityCorrelation: 0,
    overallSimilarity: 0,
    mfccScore: 0,
    pitchScore: 0,
    durationScore: 0,
    formantScore: 0,
    intensityScore: 0,
    ref: { meanPitch: 0, f1: 0, f2: 0, duration: 0, meanIntensity: 0 },
    user: { meanPitch: 0, f1: 0, f2: 0, duration: 0, meanIntensity: 0 },
    pitchContour: { ref: [], user: [] },
    vowelAnalysis: undefined,
    feedback: [message],
    audioTimestamp: 0,
  };
}
