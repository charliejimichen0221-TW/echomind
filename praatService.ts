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
const ALIGN_SCRIPT = path.join(process.cwd(), 'praat', 'align.py');

/**
 * Use Whisper to find the target word's start/end timestamps in a WAV file.
 * Returns {found, start, end} or {found: false} if word not detected.
 */
async function whisperAlign(wavPath: string, targetWord: string, useHint: boolean = false): Promise<{ found: boolean; start?: number; end?: number; word?: string }> {
  return new Promise((resolve) => {
    const args = [ALIGN_SCRIPT, wavPath, targetWord];
    if (useHint) args.push('--hint');
    execFile('python', args, { timeout: 30000 }, (err, stdout, stderr) => {
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
function extractWavSegment(wavBuffer: Buffer, sampleRate: number, startSec: number, endSec: number): Buffer {
  const headerSize = 44;
  const bytesPerSample = 2; // 16-bit
  const startByte = headerSize + Math.floor(startSec * sampleRate * bytesPerSample);
  const endByte = Math.min(wavBuffer.length, headerSize + Math.ceil(endSec * sampleRate * bytesPerSample));

  const pcmSegment = wavBuffer.slice(startByte, endByte);
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

export interface ComparisonResult {
  pitchCorrelation: number;      // -1 to 1 (1 = perfect match)
  durationRatio: number;         // user/ref ratio (1 = same speed)
  f1Similarity: number;          // 0-100%
  f2Similarity: number;          // 0-100%
  intensityCorrelation: number;  // -1 to 1
  overallSimilarity: number;     // 0-100 weighted
  ref: { meanPitch: number; f1: number; f2: number; duration: number; meanIntensity: number };
  user: { meanPitch: number; f1: number; f2: number; duration: number; meanIntensity: number };
  pitchContour: { ref: number[]; user: number[] };  // for visualization
  feedback: string[];
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
  // 1. Pitch Stability (25%)
  // CV (stdev/mean) for natural speech is typically 0.1~0.4
  // Lower = more stable (good for word repetition tasks)
  // =============================================
  let pitchStability = 100;
  if (raw.pitch.mean > 0) {
    const cv = raw.pitch.stdev / raw.pitch.mean;
    // cv < 0.15 = excellent, cv > 0.5 = poor
    pitchStability = Math.max(0, Math.min(100, Math.round(100 * (1 - cv * 1.8))));

    if (pitchStability < 40) {
      feedback.push('Your pitch varied quite a bit — try to keep a steadier tone.');
    } else if (pitchStability >= 70) {
      feedback.push('Great pitch control! Your tone is stable and clear.');
    }
  } else {
    pitchStability = 0;
    feedback.push('No voiced speech detected — make sure to speak clearly into the microphone.');
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
  // 3. Voice Quality (15%)
  // Based on jitter, shimmer, and HNR
  // Thresholds relaxed for non-studio microphones
  // =============================================
  let voiceQuality = 70;
  if (raw.hnr > 0) {
    // HNR > 15 dB is good for typical mics, < 5 dB is poor
    voiceQuality = Math.max(0, Math.min(100, Math.round((raw.hnr / 20) * 100)));
  }

  // Penalize high jitter (> 2% for non-studio = rough voice)
  if (raw.jitter > 0.02) {
    voiceQuality = Math.max(10, voiceQuality - Math.round((raw.jitter - 0.02) * 800));
    feedback.push('Your voice sounds slightly rough — try speaking at a comfortable volume.');
  }

  // Penalize high shimmer (> 8% for non-studio)
  if (raw.shimmer > 0.08) {
    voiceQuality = Math.max(10, voiceQuality - Math.round((raw.shimmer - 0.08) * 300));
  }

  if (voiceQuality >= 75) {
    feedback.push('Your voice quality is clear and resonant!');
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
    pitchStability * 0.25 +
    vowelClarity * 0.30 +
    voiceQuality * 0.15 +
    fluency * 0.30
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

    // Run alignment on BOTH files in parallel
    // Ref: no hint needed (AI speech is clear)
    // User: use hint (tells Whisper what word to expect for accented speech)
    const [refAlign, userAlign] = await Promise.all([
      whisperAlign(fullRefWavPath, targetWord, false),
      whisperAlign(fullUserWavPath, targetWord, true),
    ]);

    // ALWAYS align ref — AI speech is clear, Whisper is reliable
    if (refAlign.found && refAlign.start !== undefined && refAlign.end !== undefined) {
      const refSeg = extractWavSegment(fullRefWav, AI_OUTPUT_RATE, refAlign.start, refAlign.end);
      refWavPath = path.join(tmpDir, `echomind_ref_aligned_${ts}.wav`);
      fs.writeFileSync(refWavPath, refSeg);
      console.log(`[Whisper] ✅ Ref "${refAlign.word}" aligned: ${refAlign.start}s-${refAlign.end}s (${(refAlign.end - refAlign.start).toFixed(2)}s)`);
    } else {
      console.log(`[Whisper] ⚠️ Ref: word not found — using full ref audio`);
    }

    // Align user if possible — user speech may be unclear
    if (userAlign.found && userAlign.start !== undefined && userAlign.end !== undefined) {
      const userSeg = extractWavSegment(fullUserWav, sampleRate, userAlign.start, userAlign.end);
      userWavPath = path.join(tmpDir, `echomind_user_aligned_${ts}.wav`);
      fs.writeFileSync(userWavPath, userSeg);
      console.log(`[Whisper] ✅ User "${userAlign.word}" aligned: ${userAlign.start}s-${userAlign.end}s (${(userAlign.end - userAlign.start).toFixed(2)}s)`);
    } else {
      // Whisper couldn't find the word — fallback to trimSilence to remove silence padding
      console.log(`[Whisper] ⚠️ User: word not recognized — falling back to trimSilence`);
      const trimmedUserPCM = trimSilence(rawUserPCM, sampleRate, 'user');
      const trimmedUserWav = pcmToWav(trimmedUserPCM, sampleRate);
      userWavPath = path.join(tmpDir, `echomind_user_trimmed_${ts}.wav`);
      fs.writeFileSync(userWavPath, trimmedUserWav);
    }
  }

  // Save debug copies (after alignment — so debug files show what Praat actually compares)
  const debugDir = path.join(process.cwd(), 'debug');
  if (!fs.existsSync(debugDir)) fs.mkdirSync(debugDir, { recursive: true });
  fs.copyFileSync(refWavPath, path.join(debugDir, 'ref_recording.wav'));
  fs.copyFileSync(userWavPath, path.join(debugDir, 'user_recording.wav'));
  // Also save full (pre-alignment) copies for inspection
  fs.copyFileSync(fullRefWavPath, path.join(debugDir, 'ref_full.wav'));
  fs.copyFileSync(fullUserWavPath, path.join(debugDir, 'user_full.wav'));
  console.log(`[PraatService] 🐛 Debug files saved (aligned + full)`);

  try {
    console.log('[PraatService] 🔬 Running Praat comparison...');
    const startTime = Date.now();

    const result = await new Promise<any>((resolve, reject) => {
      execFile(
        PRAAT_EXE,
        ['--run', '--utf8', PRAAT_COMPARE_SCRIPT, refWavPath, userWavPath],
        { timeout: 30000, maxBuffer: 1024 * 512 },
        (error, stdout, stderr) => {
          if (error) {
            console.error('[PraatService] Compare error:', error.message);
            console.error('[PraatService] stderr:', stderr);
            reject(error);
            return;
          }
          try {
            const parsed = JSON.parse(stdout.toString().trim());
            resolve(parsed);
          } catch (e) {
            console.error('[PraatService] Failed to parse compare output:', stdout);
            reject(e);
          }
        }
      );
    });

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`[PraatService] ✅ Comparison completed in ${elapsed}s`);
    console.log(`[PraatService] 📊 Pitch correlation: ${result.pitchCorrelation}`);
    console.log(`[PraatService] 📊 Duration ratio: ${result.durationRatio}`);
    console.log(`[PraatService] 📊 F1 similarity: ${result.f1Similarity}% | F2 similarity: ${result.f2Similarity}%`);
    console.log(`[PraatService] 📊 Intensity correlation: ${result.intensityCorrelation}`);

    // Compute overall similarity and generate feedback
    return computeComparison(result);
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

function computeComparison(raw: any): ComparisonResult {
  const feedback: string[] = [];

  // Log DTW distance if available
  if (raw.dtwDistance !== undefined) {
    console.log(`[PraatService] 📊 DTW distance: ${raw.dtwDistance} (lower = more similar)`);
  }

  // Pitch contour similarity (40% weight)
  const pitchScore = Math.max(0, raw.pitchCorrelation * 100);
  if (pitchScore >= 70) {
    feedback.push('Great intonation! Your pitch pattern closely matches the reference.');
  } else if (pitchScore >= 40) {
    feedback.push('Your intonation is somewhat similar — try to follow the rise and fall more closely.');
  } else {
    feedback.push('Your intonation differs significantly — listen carefully to the reference pitch pattern.');
  }

  // Duration similarity (20% weight) — MORE LENIENT formula
  // ratio 0.7-1.3 = 100%, ratio 0.5-2.0 = 50%+, ratio <0.3 or >3.0 = 0%
  const durRatio = raw.durationRatio;
  let durScore: number;
  if (durRatio >= 0.7 && durRatio <= 1.3) {
    durScore = 100;  // excellent pace match
  } else if (durRatio >= 0.5 && durRatio <= 2.0) {
    // Gradual falloff outside the ideal range
    const deviation = durRatio < 0.7 ? (0.7 - durRatio) / 0.2 : (durRatio - 1.3) / 0.7;
    durScore = Math.max(50, Math.round(100 - deviation * 50));
  } else {
    durScore = Math.max(0, Math.round(50 - Math.abs(durRatio - 1) * 25));
  }

  if (durRatio > 1.5) {
    feedback.push('You spoke slower than the reference — try to speed up slightly.');
  } else if (durRatio < 0.5) {
    feedback.push('You spoke faster than the reference — try to slow down.');
  } else if (durRatio >= 0.7 && durRatio <= 1.3) {
    feedback.push('Good speaking pace — matches the reference well!');
  }

  // Formant similarity (25% weight)
  const formantScore = (raw.f1Similarity + raw.f2Similarity) / 2;
  if (formantScore >= 70) {
    feedback.push('Excellent vowel quality — your pronunciation sounds very natural!');
  } else if (formantScore < 40) {
    feedback.push('Your vowel sounds differ from the reference — try to listen and mimic the mouth shape.');
  }

  // Intensity similarity (15% weight)
  const intensityScore = Math.max(0, raw.intensityCorrelation * 100);

  // Overall weighted similarity
  const overallSimilarity = Math.round(
    pitchScore * 0.40 +
    durScore * 0.20 +
    formantScore * 0.25 +
    intensityScore * 0.15
  );

  return {
    pitchCorrelation: raw.pitchCorrelation,
    durationRatio: raw.durationRatio,
    f1Similarity: raw.f1Similarity,
    f2Similarity: raw.f2Similarity,
    intensityCorrelation: raw.intensityCorrelation,
    overallSimilarity: Math.max(0, Math.min(100, overallSimilarity)),
    ref: raw.ref,
    user: raw.user,
    pitchContour: raw.pitchContour,
    feedback,
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
    ref: { meanPitch: 0, f1: 0, f2: 0, duration: 0, meanIntensity: 0 },
    user: { meanPitch: 0, f1: 0, f2: 0, duration: 0, meanIntensity: 0 },
    pitchContour: { ref: [], user: [] },
    feedback: [message],
  };
}
