import { useState, useCallback, useRef } from 'react';
import { GoogleGenAI, Modality, LiveServerMessage } from "@google/genai";
import { AudioProcessor, AudioPlayer } from '../utils/audioUtils';
import { dbg, dbgUpdateState, dbgGetState, dbgStateTransition, dbgTimed } from '../utils/debugLogger';

// ═══════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════

export interface PronunciationScore {
  overall: number;
  pitchStability: number;
  vowelClarity: number;
  voiceQuality: number;
  fluency: number;
  details: any;
  feedback: string[];
  comparison?: ComparisonResult;
}

export interface ComparisonResult {
  pitchCorrelation: number;
  durationRatio: number;
  f1Similarity: number;
  f2Similarity: number;
  intensityCorrelation: number;
  overallSimilarity: number;
  // Pre-computed sub-scores (0-100)
  mfccScore: number;
  pitchScore: number;
  durationScore: number;
  formantScore: number;
  intensityScore: number;
  ref: { meanPitch: number; f1: number; f2: number; duration: number; meanIntensity: number };
  user: { meanPitch: number; f1: number; f2: number; duration: number; meanIntensity: number };
  pitchContour: { ref: number[]; user: number[] };
  feedback: string[];
  audioTimestamp?: number;
}

// ═══════════════════════════════════════════════
// Helpers — target word extraction (DeepSeek-V3)
// ═══════════════════════════════════════════════

async function extractTargetWord(transcript: string): Promise<string | null> {
  // Need at least 80 chars — short fragments don't have enough context
  // for DeepSeek to identify the correct target word
  if (!transcript || transcript.length < 80) return null;
  try {
    const t0 = performance.now();
    // Send only the last 300 chars to focus on the most recent word being taught
    const recentTranscript = transcript.length > 300 ? transcript.slice(-300) : transcript;
    const res = await fetch('/api/extract-target-word', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcript: recentTranscript }),
    });
    const data = await res.json();
    const ms = ((performance.now() - t0) / 1000).toFixed(2);
    console.log(`%c[DeepSeek] ${data.word ? '✅' : '❌'} "${data.word || 'null'}" (${ms}s)`, 'color: #38bdf8; font-weight: bold');
    return data.word || null;
  } catch (e) {
    console.error('[DeepSeek] Failed:', e);
    return null;
  }
}

// ═══════════════════════════════════════════════
// Helpers — fuzzy word matching
// ═══════════════════════════════════════════════

function findWordInText(text: string, target: string): { idx: number; total: number } | null {
  if (!text || !target) return null;
  const words = text.trim().split(/\s+/);
  const t = target.toLowerCase().replace(/[^a-z]/g, '');
  if (!t) return null;

  console.log(`%c[Match] 🔎 findWordInText: words=[${words.map(w => `"${w}"`).join(', ')}] target="${t}"`, 'color: #94a3b8; font-size: 10px');

  // 1. Exact single-word match
  for (let i = 0; i < words.length; i++) {
    const w = words[i].toLowerCase().replace(/[^a-z]/g, '');
    if (w === t) {
      console.log(`%c[Match] ✅ Strategy 1 (EXACT): word[${i}]="${w}" === "${t}"`, 'color: #34d399');
      return { idx: i, total: words.length };
    }
  }

  // 2. Sliding window: join consecutive words and check if they form the target
  //    This handles Gemini splitting "hypothesis" → "hy po the sis"
  for (let winSize = 2; winSize <= Math.min(words.length, 8); winSize++) {
    for (let i = 0; i <= words.length - winSize; i++) {
      const joined = words.slice(i, i + winSize).join('').toLowerCase().replace(/[^a-z]/g, '');
      if (joined === t) {
        console.log(`%c[Match] ✅ Strategy 2 (SLIDING EXACT): joined "${joined}" === "${t}" (win=${winSize}, pos=${i})`, 'color: #34d399');
        return { idx: i, total: words.length };
      }
      const sim = levenshteinSimilarity(joined, t);
      if (sim > 0.75) {
        console.log(`%c[Match] ✅ Strategy 2 (SLIDING FUZZY): joined "${joined}" ~ "${t}" sim=${sim.toFixed(3)} > 0.75 (win=${winSize}, pos=${i})`, 'color: #34d399');
        return { idx: i, total: words.length };
      }
    }
  }

  // 3. Full text contains target (fallback: user said it in a sentence)
  const fullClean = text.toLowerCase().replace(/\s+/g, '').replace(/[^a-z]/g, '');
  if (fullClean.includes(t)) {
    console.log(`%c[Match] ✅ Strategy 3 (CONTAINS): "${fullClean}" includes "${t}"`, 'color: #34d399');
    return { idx: 0, total: words.length };
  }

  // 4. Fuzzy single-word match (strict threshold: 0.75)
  let best = -1, bestScore = 0, bestWord = '';
  for (let i = 0; i < words.length; i++) {
    const w = words[i].toLowerCase().replace(/[^a-z]/g, '');
    if (w.length < 2) continue;
    const s = levenshteinSimilarity(w, t);
    if (s > bestScore) { bestScore = s; best = i; bestWord = w; }
  }
  console.log(`%c[Match] 🔎 Strategy 4 (FUZZY): best="${bestWord}" sim=${bestScore.toFixed(3)} threshold=0.75`, 'color: #94a3b8; font-size: 10px');
  if (best >= 0 && bestScore > 0.75) {
    console.log(`%c[Match] ✅ Strategy 4 (FUZZY): "${bestWord}" ~ "${t}" sim=${bestScore.toFixed(3)} > 0.75`, 'color: #34d399');
    return { idx: best, total: words.length };
  }

  console.log(`%c[Match] ❌ NO MATCH: best="${bestWord}" sim=${bestScore.toFixed(3)} < 0.75`, 'color: #f87171');
  return null;
}

function levenshteinSimilarity(a: string, b: string): number {
  const n = Math.max(a.length, b.length);
  if (n === 0) return 1;
  const m: number[][] = [];
  for (let i = 0; i <= a.length; i++) {
    m[i] = [i];
    for (let j = 1; j <= b.length; j++) {
      m[i][j] = i === 0 ? j : Math.min(
        m[i - 1][j] + 1,
        m[i][j - 1] + 1,
        m[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
  }
  return 1 - m[a.length][b.length] / n;
}

// ═══════════════════════════════════════════════
// Hook
// ═══════════════════════════════════════════════

export function useLiveAPI() {
  // ── React state ──
  const [isConnected, setIsConnected] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [volume, setVolume] = useState(0);
  const [transcript, setTranscript] = useState<{ role: 'user' | 'model'; text: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pronunciationScore, setPronunciationScore] = useState<PronunciationScore | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [currentTargetWord, setCurrentTargetWord] = useState<string | null>(null);
  const [recognizedSpeech, setRecognizedSpeech] = useState<string | null>(null);
  const [speechMismatch, setSpeechMismatch] = useState(false);

  // ── Refs ──
  const sessionRef = useRef<any>(null);
  const processorRef = useRef<AudioProcessor | null>(null);
  const playerRef = useRef<AudioPlayer | null>(null);

  const aiTurnActiveRef = useRef(false);          // true while AI audio is streaming
  const aiTranscriptRef = useRef('');              // accumulates outputTranscription for current AI turn
  const userTranscriptRef = useRef('');             // accumulates inputTranscription for current user turn
  const targetWordRef = useRef<string | null>(null);
  const lastAiChunksRef = useRef<string[]>([]);    // saved AI reference audio (for Praat comparison)
  const lastAiTextRef = useRef('');                 // saved AI reference transcript
  const skipNextAnalysisRef = useRef(false);        // true = AI is responding to Praat, don't re-analyze
  const isPraatResponseRef = useRef(false);           // true = current AI turn is a Praat feedback response (don't save as ref)
  const extractTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastPraatTimeRef = useRef(0);              // cooldown: last time runPraatAnalysis ran successfully
  const praatDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);  // debounce for empty turnComplete → Praat trigger

  // ═══════════════════════════════════════════════
  // AI reference audio extraction (for Praat comparison)
  // Uses text-based proportional mapping to find the target word's
  // position in the audio — simpler and more accurate than real-time
  // chunk tracking during streaming.
  // ═══════════════════════════════════════════════

  function getRefChunksForWord(allChunks: string[], word: string | null, aiText: string): string[] {
    if (allChunks.length === 0) return [];

    // At 24kHz, each chunk ≈ 0.04s
    const WORD_WINDOW = 50;  // ~2 seconds window

    // Short enough — use all without trimming
    if (allChunks.length <= WORD_WINDOW) {
      console.log(`%c[Praat] 📤 Ref: ALL ${allChunks.length} chunks (~${(allChunks.length * 0.04).toFixed(1)}s) for "${word || 'unknown'}"`, 'color: #818cf8');
      return allChunks;
    }

    // ── Text-based position estimation ──
    // Find the target word in the saved AI transcript and map its text
    // position proportionally to chunk position.
    // e.g. "Now repeat after me... analyze" → "analyze" at 82% of text → chunk 82%
    if (word && aiText) {
      const textLower = aiText.toLowerCase();
      const wordLower = word.toLowerCase();
      // Use lastIndexOf — if the word appears multiple times, the last occurrence
      // (closest to "repeat after me [word]") is most likely the pronunciation model
      const wordPos = textLower.lastIndexOf(wordLower);

      if (wordPos >= 0) {
        // Map text position to chunk position proportionally
        // Use the END of the word in text to estimate when the AI finished saying it
        const wordEndInText = wordPos + wordLower.length;
        const textRatio = wordEndInText / aiText.length;
        const estimatedChunkEnd = Math.round(allChunks.length * textRatio);

        // Window ends after the estimated word position (+15 chunks padding for trailing audio)
        const windowEnd = Math.min(allChunks.length, estimatedChunkEnd + 15);
        const start = Math.max(0, windowEnd - WORD_WINDOW);
        const end = Math.min(allChunks.length, start + WORD_WINDOW);

        const refChunks = allChunks.slice(start, end);
        console.log(
          `%c[Praat] 📤 Ref: SMART ${refChunks.length} chunks [${start}..${end}) (~${(refChunks.length * 0.04).toFixed(1)}s) | ` +
          `"${word}" at text pos ${wordPos}/${aiText.length} (${(textRatio * 100).toFixed(0)}%) → est chunk ${estimatedChunkEnd}/${allChunks.length}`,
          'color: #818cf8; font-weight: bold'
        );
        return refChunks;
      }
    }

    // ── Fallback: take last chunks (word not found in text) ──
    const MAX_FALLBACK = 75;  // ~3 seconds
    const refChunks = allChunks.slice(-MAX_FALLBACK);
    console.log(`%c[Praat] 📤 Ref: FALLBACK last ${refChunks.length}/${allChunks.length} chunks (~${(refChunks.length * 0.04).toFixed(1)}s) for "${word || 'unknown'}"`, 'color: #818cf8');
    return refChunks;
  }

  // ═══════════════════════════════════════════════
  // Praat analysis
  // ═══════════════════════════════════════════════

  const runPraatAnalysis = useCallback(async () => {
    const proc = processorRef.current;
    if (!proc) return;

    // ── Cooldown: prevent rapid re-triggering (5s) ──
    const now = Date.now();
    const elapsed = now - lastPraatTimeRef.current;
    if (elapsed < 5000) {
      dbg('praat', `⏭️ runPraatAnalysis: Skip — cooldown (${(elapsed / 1000).toFixed(1)}s < 5s since last run)`);
      return;
    }

    // ── Check 1: Has audio? ──
    if (!proc.hasUserAudio()) {
      dbg('praat', '⏭️ runPraatAnalysis: Skip — no user audio buffered');
      return;
    }

    const sampleRate = proc.getSampleRate();
    const target = targetWordRef.current;
    const rawUserText = userTranscriptRef.current.trim();

    // ── Check 2: Do we have a target word? ──
    if (!target) {
      dbg('praat', '⏭️ Skip — no target word set yet');
      setRecognizedSpeech(null);
      const stats = processorRef.current?.getBufferStats();
      dbg('buffer', `🗑️ CLEAR (no target): ${stats?.chunks ?? 0} chunks discarded`);
      processorRef.current?.clearUserBuffer();
      dbgUpdateState({ userChunkCount: 0, bufferMemoryKB: 0, bufferDurationSec: 0, bufferClearCount: dbgGetState().bufferClearCount + 1 });
      return;
    }

    // ── Check 3: Did user say the target word? ──
    const cleanUserText = rawUserText.replace(/[^a-zA-Z\s]/g, '').trim();
    dbg('match', `🔍 Matching: userText="${cleanUserText}" vs target="${target}"`);
    let matchResult: { idx: number; total: number } | null = null;
    if (cleanUserText.length >= 2) {
      matchResult = findWordInText(cleanUserText, target);
      if (!matchResult) {
        dbg('match', `❌ MISMATCH: "${cleanUserText}" ≠ "${target}" — skipping analysis`);
        dbgUpdateState({ lastMatchResult: `MISMATCH: "${cleanUserText}" ≠ "${target}"` });
        setRecognizedSpeech(null);
        setSpeechMismatch(true);
        setTimeout(() => setSpeechMismatch(false), 3000);
        userTranscriptRef.current = '';  // clear stale text to avoid contaminating next match
        return;
      }
      // Matched!
      dbg('match', `✅ MATCHED: "${cleanUserText}" contains "${target}" at idx=${matchResult.idx}/${matchResult.total}`);
      dbgUpdateState({ lastMatchResult: `MATCHED: "${cleanUserText}" contains "${target}"` });
      setRecognizedSpeech(cleanUserText);
      setSpeechMismatch(false);
    } else {
      dbg('praat', `⏭️ Skip — no usable speech (cleanUserText="${cleanUserText}", len=${cleanUserText.length})`);
      setRecognizedSpeech(null);
      // DON'T clear buffer here — keep audio for next trigger attempt
      return;
    }

    // ── Match succeeded! Now flush audio and clear transcript ──
    lastPraatTimeRef.current = Date.now(); // start cooldown
    let userChunks = proc.flushUserBuffer();
    if (userChunks.length === 0) return;
    userTranscriptRef.current = '';
    const flushMemKB = (userChunks.length * 8192 / 1024);
    const flushDurSec = (userChunks.length * 4096 / sampleRate);
    dbg('buffer', `📤 FLUSH: ${userChunks.length} chunks (${flushDurSec.toFixed(1)}s, ${flushMemKB.toFixed(0)}KB) — transcript cleared`);
    dbg('praat', `🎤 Flushed user buffer: ${userChunks.length} chunks, transcript cleared`);
    dbgUpdateState({
      userChunkCount: 0,
      bufferMemoryKB: 0,
      bufferDurationSec: 0,
      bufferFlushCount: dbgGetState().bufferFlushCount + 1
    });

    // ── Smart trimming: End-Anchored Activity Window ──
    // If the user buffer is huge (e.g. 90s), it's likely because they had the mic open
    // without speaking for a long time. The actual sentence was spoken at the END.
    // Global proportional mapping (idx/total * totalChunks) fails completely if there's long silence.
    // Solution: We extract a generous window (up to 30s) from the END of the active audio.
    const MAX_USER_CHUNKS = 100;    // ~25.6s at 4096/16000
    const ACTIVE_SENTENCE_CHUNKS = Math.min(userChunks.length, 120); // ~30s max of recent activity

    if (userChunks.length > MAX_USER_CHUNKS) {
      const totalChunks = userChunks.length;

      // Assume the spoken sentence occupies the last ACTIVE_SENTENCE_CHUNKS.
      // We map the word position ratio within this active tail, NOT the whole 90s buffer.
      const wordRatio = matchResult.total > 1 ? matchResult.idx / matchResult.total : 0.5;

      // The start of the active tail:
      const activeTailStart = totalChunks - ACTIVE_SENTENCE_CHUNKS;

      // Where in the active tail is the word?
      const estimatedCenter = activeTailStart + Math.floor(wordRatio * ACTIVE_SENTENCE_CHUNKS);
      const halfWindow = Math.floor(MAX_USER_CHUNKS / 2);

      // Center the window around estimatedCenter, clamp to valid bounds
      let startChunk = Math.max(0, estimatedCenter - halfWindow);
      let endChunk = startChunk + MAX_USER_CHUNKS;

      // If we hit the end of the buffer, shift the window left
      if (endChunk > totalChunks) {
        endChunk = totalChunks;
        startChunk = Math.max(0, endChunk - MAX_USER_CHUNKS);
      }

      dbg('audio', `✂️ User buffer too long: ${totalChunks} chunks (~${(totalChunks * 4096 / sampleRate).toFixed(1)}s)`);
      dbg('audio', `✂️ Target "${target}" at word ${matchResult.idx}/${matchResult.total} (${(wordRatio * 100).toFixed(0)}%) of active tail`);
      dbg('audio', `✂️ Trimming to chunks [${startChunk}..${endChunk}) = ${endChunk - startChunk} chunks (~${((endChunk - startChunk) * 4096 / sampleRate).toFixed(1)}s)`);

      userChunks = userChunks.slice(startChunk, endChunk);
    } else {
      dbg('audio', `📦 User buffer OK: ${userChunks.length} chunks (~${(userChunks.length * 4096 / sampleRate).toFixed(1)}s)`);
    }

    // Send all user chunks to server — Whisper handles alignment there
    const chunks = userChunks;

    // Note: server-side trimSilence handles silence removal, no need to truncate here

    const duration = (chunks.length * 4096 / sampleRate).toFixed(1);
    console.log(`%c[Praat] 🔬 Analyzing ${chunks.length} chunks (~${duration}s)${target ? ` [${target}]` : ''}`, 'color: #a78bfa; font-weight: bold');

    setIsAnalyzing(true);
    const t0 = performance.now();

    try {
      const r1 = await fetch('/api/analyze-pronunciation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audioChunks: chunks, sampleRate }),
      });
      const d1 = await r1.json();

      let score: PronunciationScore | null = null;
      if (d1.status === 'success') {
        score = d1.score;
        dbg('praat', `✅ Analysis done (${((performance.now() - t0) / 1000).toFixed(2)}s) — Overall: ${score!.overall}`);
      } else {
        dbg('error', `Praat analysis returned non-success:`, d1);
      }

      // ── Step 2: Compare with AI reference ──
      if (score && lastAiChunksRef.current.length > 0) {
        dbg('audio', `🔄 Comparing with ref: ${lastAiChunksRef.current.length} total ref chunks, target="${target}"`);
        const refChunks = getRefChunksForWord(lastAiChunksRef.current, target, lastAiTextRef.current);
        if (refChunks.length > 0) {
          dbg('audio', `📤 Sending compare: ref=${refChunks.length} chunks (~${(refChunks.length * 0.04).toFixed(1)}s), user=${chunks.length} chunks`);
          const r2 = await fetch('/api/compare-pronunciation', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refChunks, userChunks: chunks, sampleRate, targetWord: target }),
          });
          const d2 = await r2.json();
          if (d2.status === 'success') {
            score.comparison = d2.comparison;
            dbg('praat', `✅ Similarity: ${d2.comparison.overallSimilarity}% | MFCC: ${d2.comparison.mfccScore} | audioTimestamp: ${d2.comparison.audioTimestamp}`);
          } else {
            dbg('error', 'Compare returned non-success:', d2);
          }
        }
      } else {
        dbg('audio', `⏭️ No comparison — refChunks=${lastAiChunksRef.current.length}, score=${!!score}`);
      }

      // ── Step 3: Update UI + send to AI ──
      if (score) {
        setPronunciationScore(score);

        // ── Save to pronunciation history DB ──
        fetch('/api/pronunciation-history', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            word: target,
            scores: {
              overall: score.overall,
              pitchStability: score.pitchStability,
              vowelClarity: score.vowelClarity,
              voiceQuality: score.voiceQuality,
              fluency: score.fluency,
            },
            comparison: score.comparison || null,
            category: 'general',
            matched: true,
          }),
        }).catch(err => console.warn('[DB] Save failed:', err));

        const comp = score.comparison;
        const lines = [
          `[PRONUNCIATION_ANALYSIS_RESULT]`,
          `Target word: ${target || 'unknown'}`,
          ``,
          `Praat acoustic analysis:`,
          `  Overall: ${score.overall}/100`,
          `  Pitch stability: ${score.pitchStability}/100`,
          `  Vowel clarity: ${score.vowelClarity}/100`,
          `  Voice quality: ${score.voiceQuality}/100`,
          `  Fluency: ${score.fluency}/100`,
        ];
        if (comp) {
          lines.push(
            `  Similarity: ${comp.overallSimilarity}%`,
            `  Pitch match: ${(comp.pitchCorrelation * 100).toFixed(1)}%`,
            `  Vowel F1: ${comp.f1Similarity.toFixed(1)}%`,
            `  Vowel F2: ${comp.f2Similarity.toFixed(1)}%`,
            `  Pace ratio: ${comp.durationRatio.toFixed(2)}x`,
          );
        }
        lines.push(
          '',
          'INSTRUCTIONS: Give brief data-driven pronunciation feedback (1-2 sentences). Cite specific scores.',
          'IMPORTANT: Do NOT restart the pronunciation drill or ask them to repeat the word again. Continue naturally from wherever the conversation currently is.',
          'If you already moved on (e.g., asked for a sentence), keep that flow — just briefly mention the score, then continue with what you were doing.',
          'Example: "By the way, your pronunciation scored 65% — your vowels were good but the pace was a bit slow. Now, back to your sentence..."',
        );

        if (sessionRef.current) {
          dbg('praat', '📤 Sending [PRONUNCIATION_ANALYSIS_RESULT] to AI...');
          dbg('praat', `  skipNextAnalysis will be set to TRUE`);
          skipNextAnalysisRef.current = true;
          dbgUpdateState({ skipNextAnalysis: true });
          try {
            await sessionRef.current.sendClientContent({
              turns: [{ role: 'user', parts: [{ text: lines.join('\n') }] }],
              turnComplete: true,
            });
            dbg('praat', '✅ Praat result sent to AI successfully');
          } catch (err) {
            dbg('error', '💥 Failed to send Praat result to AI:', err);
            skipNextAnalysisRef.current = false;
            dbgUpdateState({ skipNextAnalysis: false });
          }
        } else {
          dbg('error', '⚠️ Cannot send Praat result — no active session!');
        }
      }
    } catch (err) {
      dbg('error', '💥 runPraatAnalysis FAILED:', err);
      console.error('[Praat] ❌ Analysis failed:', err);
    } finally {
      setIsAnalyzing(false);
    }
  }, []);

  // ═══════════════════════════════════════════════
  // Connect to Gemini Live API
  // ═══════════════════════════════════════════════

  const connect = useCallback(async (systemInstruction: string) => {
    try {
      dbg('flow', '🚀 CONNECT: Initializing session...');
      dbgUpdateState({ sessionActive: true, turnCount: 0, analysisCount: 0, errorCount: 0 });
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      processorRef.current = new AudioProcessor();
      playerRef.current = new AudioPlayer((v) => setVolume(v));
      processorRef.current.setBuffering(false); // start with buffering OFF (AI will speak first)
      // Register buffer stats callback for debug monitoring
      processorRef.current.setOnBufferUpdate((stats) => {
        dbgUpdateState({
          userChunkCount: stats.chunks,
          bufferMemoryKB: stats.memoryKB,
          bufferDurationSec: stats.durationSec,
          bufferPeakChunks: stats.peak,
        });
      });
      dbg('audio', 'AudioProcessor & AudioPlayer created, buffering OFF');

      const session = await ai.live.connect({
        model: "gemini-2.5-flash-native-audio-preview-09-2025",
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Zephyr" } } },
          systemInstruction,
          outputAudioTranscription: {},
          inputAudioTranscription: {},
        },
        callbacks: {
          // ────────────────────────────
          onopen: () => {
            dbg('flow', '✅ CONNECTED: WebSocket open, starting mic recording');
            setIsConnected(true);
            setError(null);
            processorRef.current?.startRecording((base64) => {
              session.sendRealtimeInput({ media: { data: base64, mimeType: 'audio/pcm;rate=16000' } });
            });
          },

          // ────────────────────────────
          onmessage: async (msg: LiveServerMessage) => {

            // ╔═══════════════════════════╗
            // ║  AI audio chunk received   ║
            // ╚═══════════════════════════╝
            const audio = msg.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (audio) {

              // ── First chunk of a new AI turn ──
              if (!aiTurnActiveRef.current) {
                aiTurnActiveRef.current = true;
                dbgUpdateState({ aiTurnActive: true });
                dbg('flow', `═══ AI TURN START ═══ target="${targetWordRef.current}" skipAnalysis=${skipNextAnalysisRef.current} isPraatResp=${isPraatResponseRef.current}`);
                if (extractTimerRef.current) { clearTimeout(extractTimerRef.current); extractTimerRef.current = null; }

                // Cancel any pending debounce — AI speaking means user is done
                if (praatDebounceRef.current) {
                  dbg('buffer', `⏳ Debounce CANCELLED — AI started speaking`);
                  clearTimeout(praatDebounceRef.current);
                  praatDebounceRef.current = null;
                  dbgUpdateState({ praatDebounceActive: false });
                }

                // Clear previous turn transcript for new turn
                aiTranscriptRef.current = '';

                // ── Trigger Praat analysis ──
                if (skipNextAnalysisRef.current) {
                  skipNextAnalysisRef.current = false;
                  isPraatResponseRef.current = true;   // mark this turn as Praat feedback response
                  dbg('praat', '⏭️ Skip analysis — AI responding to Praat data (will NOT save ref audio)');
                  dbgUpdateState({ skipNextAnalysis: false, isPraatResponse: true });
                } else {
                  isPraatResponseRef.current = false;
                  const userChunks = processorRef.current?.getUserChunkCount?.() ?? 0;
                  const hasEnoughAudio = userChunks >= 3;
                  dbg('praat', `AI started → userChunks=${userChunks}, hasEnough=${hasEnoughAudio}, target="${targetWordRef.current}", userText="${userTranscriptRef.current.trim().substring(0, 60)}"`);
                  if (hasEnoughAudio) {
                    dbg('praat', '🤖 AI started responding — triggering Praat analysis immediately');
                    runPraatAnalysis();
                  } else {
                    dbg('praat', '⏭️ Skip — not enough user audio');
                    const stats = processorRef.current?.getBufferStats();
                    dbg('buffer', `🗑️ CLEAR (AI started, not enough audio): ${stats?.chunks ?? 0} chunks discarded`);
                    processorRef.current?.clearUserBuffer();
                    dbgUpdateState({ userChunkCount: 0, bufferMemoryKB: 0, bufferDurationSec: 0, bufferClearCount: dbgGetState().bufferClearCount + 1 });
                    // Issue #012: Do NOT clear userTranscriptRef here!
                    // The AI responded before enough audio was buffered, but inputTranscription
                    // events are still valid. Clearing the transcript loses the target word.
                  }
                }
              }

              // ── Play + buffer ──
              setIsSpeaking(true);
              processorRef.current?.setBuffering(false);  // stop user buffering while AI plays
              dbg('buffer', `🔴 Buffering OFF — AI speaking`);
              dbgUpdateState({ isBuffering: false });
              processorRef.current?.addAiChunk(audio);
              playerRef.current?.play(audio);
            }

            // ╔═══════════════════════════╗
            // ║  AI text part (rare)       ║
            // ╚═══════════════════════════╝
            if (msg.serverContent?.modelTurn?.parts) {
              const text = msg.serverContent.modelTurn.parts.find(p => p.text)?.text;
              if (text) {
                setTranscript(prev => [...prev, { role: 'model', text }]);
                aiTranscriptRef.current += ' ' + text;
              }
            }

            // ╔═══════════════════════════╗
            // ║  AI output transcription   ║
            // ╚═══════════════════════════╝
            const outText = (msg as any).serverContent?.outputTranscription?.text;
            if (outText) {
              aiTranscriptRef.current += ' ' + outText;



              // Skip target word extraction during Praat feedback turns
              if (!isPraatResponseRef.current) {
                const full = aiTranscriptRef.current.replace(/\s+/g, ' ').trim();

                // ── Primary: parse "repeat after me... [word]" pattern (instant, free, 100% reliable) ──
                const echoMatch = full.match(/repeat\s+after\s+me[,.\s…—:;-]*(\w{3,})/i);
                if (echoMatch) {
                  const detected = echoMatch[1].toLowerCase();

                  if (detected !== targetWordRef.current) {
                    dbg('match', `🎯 Target word CHANGED via echo: "${targetWordRef.current}" → "${detected}"`);
                    dbgUpdateState({ targetWord: detected, lastRefChunkCount: 0, refClearedByWordChange: dbgGetState().refClearedByWordChange + 1, lastRefAction: `CLEARED: word → "${detected}"`, lastRefTimestamp: Date.now() });
                    console.log(`%c[Echo] 🎯 Target word CHANGED: "${targetWordRef.current}" → "${detected}" — clearing ref`, 'color: #34d399; font-weight: bold');
                    targetWordRef.current = detected;
                    setCurrentTargetWord(detected);
                    lastAiChunksRef.current = [];  // clear ref only for NEW word

                    // Critical fix: If AI changed the target word during a Praat response turn,
                    // this turn is no longer just feedback — it's a new drill prompt!
                    // We MUST NOT discard its audio at turnComplete.
                    isPraatResponseRef.current = false;
                    dbgUpdateState({ isPraatResponse: false });
                  } else {
                    dbg('match', `🎯 Target word SAME: "${detected}" — keeping existing ref (${lastAiChunksRef.current.length} chunks)`);
                  }
                  // Cancel any pending DeepSeek call — we already have the word
                  if (extractTimerRef.current) { clearTimeout(extractTimerRef.current); extractTimerRef.current = null; }
                } else {
                  // ── Fallback: DeepSeek extraction (only if "repeat after me" not found) ──
                  if (extractTimerRef.current) clearTimeout(extractTimerRef.current);
                  extractTimerRef.current = setTimeout(() => {
                    if (isPraatResponseRef.current) return;
                    // Re-check for echo pattern one more time with full accumulated text
                    const fullText = aiTranscriptRef.current.replace(/\s+/g, ' ').trim();
                    const recheck = fullText.match(/repeat\s+after\s+me[,.\s…—:;-]*(\w{3,})/i);
                    if (recheck) {
                      const w = recheck[1].toLowerCase();

                      if (w !== targetWordRef.current) {
                        console.log(`%c[Echo] 🎯 Target word (delayed): "${w}"`, 'color: #34d399; font-weight: bold');
                        targetWordRef.current = w;
                        setCurrentTargetWord(w);
                        lastAiChunksRef.current = [];
                        dbgUpdateState({ targetWord: w, lastRefChunkCount: 0, refClearedByWordChange: dbgGetState().refClearedByWordChange + 1, lastRefAction: `CLEARED: word → "${w}" (delayed)`, lastRefTimestamp: Date.now() });
                      }
                      return;
                    }
                    // Still not found — use DeepSeek as last resort
                    if (fullText.length > 80) {
                      extractTargetWord(fullText).then(w => {
                        if (w && w !== targetWordRef.current) {
                          console.log(`%c[DeepSeek] 🎯 Target word CHANGED: "${targetWordRef.current}" → "${w}" — clearing ref`, 'color: #38bdf8; font-weight: bold');
                          targetWordRef.current = w;
                          setCurrentTargetWord(w);
                          lastAiChunksRef.current = [];
                          dbgUpdateState({ targetWord: w, lastRefChunkCount: 0, refClearedByWordChange: dbgGetState().refClearedByWordChange + 1, lastRefAction: `CLEARED: word → "${w}" (DeepSeek)`, lastRefTimestamp: Date.now() });
                        } else if (w) {
                          console.log(`%c[DeepSeek] ✅ Target word confirmed: "${w}"`, 'color: #38bdf8');
                        }
                      });
                    }
                  }, 3000);
                }
              }
            }

            // ╔═══════════════════════════╗
            // ║  Turn complete             ║
            // ╚═══════════════════════════╝
            if (msg.serverContent?.turnComplete) {
              const isEmptyTurn = !aiTurnActiveRef.current;
              dbg('flow', `═══ AI TURN COMPLETE ═══ isEmptyTurn=${isEmptyTurn} isPraatResp=${isPraatResponseRef.current} aiTranscript="${aiTranscriptRef.current.trim().substring(0, 80)}..."`);

              setIsSpeaking(false);
              aiTurnActiveRef.current = false;
              dbgUpdateState({ aiTurnActive: false });

              if (isEmptyTurn) {
                // The AI didn't output audio this turn. 
                // Because of our strict system prompt, it often waits silently for Praat analysis results!
                const userChunks = processorRef.current?.getUserChunkCount?.() ?? 0;
                const cleanUserText = userTranscriptRef.current.replace(/[^a-zA-Z\s]/g, '').trim();

                if (userChunks >= 3 && targetWordRef.current && cleanUserText.length > 0) {
                  // Issue #013: Don't trigger immediately! Gemini sends empty turnCompletes
                  // while user is still mid-sentence. Use a 2s debounce so we capture
                  // the full utterance. Each new empty turnComplete resets the timer.
                  // The timer is cancelled and Praat triggered immediately when AI actually
                  // starts responding (= reliable signal user stopped speaking).
                  if (praatDebounceRef.current) clearTimeout(praatDebounceRef.current);
                  dbg('praat', `⏳ Empty turn with speech detected — setting 2s debounce (chunks=${userChunks}, text="${cleanUserText.substring(0, 40)}")`);
                  dbgUpdateState({ praatDebounceActive: true });
                  praatDebounceRef.current = setTimeout(() => {
                    praatDebounceRef.current = null;
                    dbgUpdateState({ praatDebounceActive: false });
                    const currentChunks = processorRef.current?.getUserChunkCount?.() ?? 0;
                    const currentText = userTranscriptRef.current.replace(/[^a-zA-Z\s]/g, '').trim();
                    if (currentChunks >= 3 && currentText.length > 0) {
                      dbg('praat', `🤖 Debounce fired — user likely finished (chunks=${currentChunks}, text="${currentText.substring(0, 40)}")`);
                      runPraatAnalysis();
                    } else {
                      dbg('praat', `⏭️ Debounce fired but conditions no longer met (chunks=${currentChunks}, text="${currentText.substring(0, 20)}"`);
                    }
                  }, 2000);
                } else if (!targetWordRef.current) {
                  // No active pronunciation drill — safe to clear buffer
                  dbg('audio', '⏭️ Empty turn, no target word. Clearing user buffer.');
                  const stats = processorRef.current?.getBufferStats();
                  dbg('buffer', `🗑️ CLEAR (empty turn, no target): ${stats?.chunks ?? 0} chunks discarded`);
                  processorRef.current?.clearUserBuffer();
                  userTranscriptRef.current = '';
                  dbgUpdateState({ userChunkCount: 0, bufferMemoryKB: 0, bufferDurationSec: 0, bufferClearCount: dbgGetState().bufferClearCount + 1 });
                } else {
                  // Target word is set but user hasn't spoken yet (or transcript not accumulated)
                  // DO NOT clear buffer — keep accumulating audio until user speaks!
                  // (Issue #011: clearing here discards user speech captured between empty turnCompletes)
                  dbg('audio', `⏭️ Empty turn — keeping buffer (${userChunks} chunks) waiting for user speech. target="${targetWordRef.current}" text="${cleanUserText.substring(0, 40)}"`);
                }
              } else {
                // It was a real AI turn. Save AI reference audio for Praat comparison
                // BUT skip saving if this turn was a Praat feedback response (short feedback audio, not a new word)
                if (isPraatResponseRef.current) {
                  // Flush AI buffer to discard feedback audio, but don't overwrite the reference
                  if (processorRef.current?.hasAiAudio()) {
                    const discardedLen = processorRef.current.flushAiBuffer().length;
                    dbg('audio', `🗑️ Discarded Praat feedback audio (${discardedLen} chunks) — keeping previous ref (${lastAiChunksRef.current.length} chunks)`);
                    dbgUpdateState({ refDiscardedCount: dbgGetState().refDiscardedCount + 1, lastRefAction: `DISCARDED: ${discardedLen} feedback chunks`, lastRefTimestamp: Date.now() });
                  }
                  isPraatResponseRef.current = false;
                  dbgUpdateState({ isPraatResponse: false });
                } else if (processorRef.current?.hasAiAudio()) {
                  const newChunks = processorRef.current.flushAiBuffer();
                  const existingLen = lastAiChunksRef.current.length;

                  if (existingLen === 0 || newChunks.length > existingLen) {
                    lastAiChunksRef.current = newChunks;
                    lastAiTextRef.current = aiTranscriptRef.current.replace(/\s+/g, ' ').trim();
                    dbg('audio', `💾 REF SAVED: ${newChunks.length} chunks (~${(newChunks.length * 0.04).toFixed(1)}s) replaced ${existingLen} | text="${lastAiTextRef.current.substring(0, 80)}"`);
                    dbgUpdateState({ lastRefChunkCount: newChunks.length, aiChunkCount: newChunks.length, refSavedCount: dbgGetState().refSavedCount + 1, lastRefAction: `SAVED: ${newChunks.length} chunks (~${(newChunks.length * 0.04).toFixed(1)}s)`, lastRefTimestamp: Date.now() });
                  } else {
                    dbg('audio', `⏭️ REF KEPT: existing ${existingLen} chunks > new ${newChunks.length} chunks`);
                    dbgUpdateState({ refKeptCount: dbgGetState().refKeptCount + 1, lastRefAction: `KEPT: existing ${existingLen} > new ${newChunks.length}`, lastRefTimestamp: Date.now() });
                  }
                } else {
                  dbg('audio', '⚠️ Turn complete but NO AI audio in buffer');
                }

                // Clear user buffer after AI's full turn, getting ready for user
                const turnEndStats = processorRef.current?.getBufferStats();
                dbg('buffer', `🗑️ CLEAR (AI turn complete): ${turnEndStats?.chunks ?? 0} chunks discarded — ready for next user turn`);
                processorRef.current?.clearUserBuffer();
                dbgUpdateState({ userChunkCount: 0, bufferMemoryKB: 0, bufferDurationSec: 0, bufferClearCount: dbgGetState().bufferClearCount + 1 });
                // Cancel any pending debounce since AI just finished a real turn
                if (praatDebounceRef.current) { clearTimeout(praatDebounceRef.current); praatDebounceRef.current = null; dbgUpdateState({ praatDebounceActive: false }); }
              }

              // Always ensure buffering is ON while waiting
              processorRef.current?.setBuffering(true);
              dbg('buffer', `🟢 Buffering ON — waiting for user speech`);
              dbg('audio', '⏺️ Buffering ON — waiting for user speech');
              dbgUpdateState({ isBuffering: true, userChunkCount: 0 });
            }

            // ╔═══════════════════════════╗
            // ║  Interrupted               ║
            // ╚═══════════════════════════╝
            if (msg.serverContent?.interrupted) {
              dbg('flow', '⚡ INTERRUPTED by user — stopping AI, clearing buffers');
              playerRef.current?.stop();
              setIsSpeaking(false);
              aiTurnActiveRef.current = false;
              const intStats = processorRef.current?.getBufferStats();
              dbg('buffer', `🗑️ CLEAR (interrupted): ${intStats?.chunks ?? 0} user chunks discarded`);
              processorRef.current?.clearUserBuffer();
              processorRef.current?.clearAiBuffer();
              processorRef.current?.setBuffering(true);
              dbg('buffer', `⏺️ Buffering ON after interrupt`);
              dbgUpdateState({ userChunkCount: 0, bufferMemoryKB: 0, bufferDurationSec: 0, bufferClearCount: dbgGetState().bufferClearCount + 1 });
              // Issue #012: Only clear transcript when NOT in a pronunciation drill.
              // During drill, user may interrupt AI while speaking their sentence —
              // clearing transcript here would lose the beginning of their utterance.
              if (!targetWordRef.current) {
                userTranscriptRef.current = '';
              } else {
                dbg('audio', `⚡ Interrupted — keeping transcript for drill: "${userTranscriptRef.current.trim().substring(0, 50)}"`);
              }
              aiTranscriptRef.current = '';
              dbgUpdateState({ aiTurnActive: false, isBuffering: true, userChunkCount: 0, aiChunkCount: 0 });
            }

            // ╔═══════════════════════════╗
            // ║  User input transcription  ║
            // ╚═══════════════════════════╝
            const inText = (msg as any).serverContent?.inputTranscription?.text;
            if (inText) {
              userTranscriptRef.current += ' ' + inText;
              dbg('match', `👤 User said: "${inText}" | accumulated: "${userTranscriptRef.current.trim().substring(0, 80)}" | target="${targetWordRef.current}"`);
              console.log(`%c[User] 👤 "${inText}"`, 'color: #fbbf24');
            }
          },

          // ────────────────────────────
          onclose: (ev: any) => {
            const code = ev?.code ?? ev?.closeCode ?? 'unknown';
            const reason = ev?.reason ?? ev?.closeReason ?? '';
            dbg('flow', `🔌 ONCLOSE: WebSocket closed — code=${code} reason="${reason}"`);
            console.error(`[Live API] WebSocket closed: code=${code}, reason=${reason}`, ev);
            dbgUpdateState({ sessionActive: false });
            if (reason.toLowerCase().includes('resource_exhausted') || reason.toLowerCase().includes('quota')) {
              setError('Gemini API 額度已用完，請等幾分鐘再試。');
            } else if (code !== 1000 && code !== 'unknown') {
              setError(`連線被關閉 (code=${code}): ${reason || '未知原因'}`);
            }
            setIsConnected(false);
            processorRef.current?.stopRecording();
          },
          onerror: (err: any) => {
            const msg = err?.message || err?.error?.message || JSON.stringify(err) || String(err);
            dbg('error', `💥 ONERROR: WebSocket error — ${msg}`, err);
            console.error("[Live API] Error details:", err);
            dbgUpdateState({ sessionActive: false, lastError: msg });
            if (msg.includes('RESOURCE_EXHAUSTED') || msg.includes('quota')) {
              setError('Gemini API 額度已用完，請等幾分鐘再試。');
            } else {
              setError(`連線錯誤: ${msg.substring(0, 120)}`);
            }
            setIsConnected(false);
          }
        }
      });

      sessionRef.current = session;
    } catch (err) {
      dbg('error', '💥 CONNECT FAILED:', err);
      dbgUpdateState({ sessionActive: false, lastError: String(err) });
      console.error("Connect failed:", err);
      setError("Failed to initialize.");
    }
  }, [runPraatAnalysis]);

  // ═══════════════════════════════════════════════
  // Disconnect
  // ═══════════════════════════════════════════════

  const disconnect = useCallback(() => {
    dbg('flow', '🛑 DISCONNECT: User-initiated disconnect');
    dbgUpdateState({ sessionActive: false });
    sessionRef.current?.close();
    processorRef.current?.stopRecording();
    playerRef.current?.stop();
    if (praatDebounceRef.current) { clearTimeout(praatDebounceRef.current); praatDebounceRef.current = null; }
    if (extractTimerRef.current) { clearTimeout(extractTimerRef.current); extractTimerRef.current = null; }
    setIsConnected(false);
    setIsSpeaking(false);
  }, []);

  // ── Buffering control for external use (e.g., audio playback) ──
  const setBuffering = useCallback((on: boolean) => {
    processorRef.current?.setBuffering(on);
  }, []);

  // ── AI playback control (pause/resume when user plays comparison audio) ──
  const pauseAI = useCallback(async () => {
    dbg('flow', '⏸️ PAUSE AI: Muting mic + suspending playback');
    dbgUpdateState({ isMuted: true, isBuffering: false });
    processorRef.current?.setMuted(true);
    processorRef.current?.setBuffering(false);
    await playerRef.current?.suspend();
  }, []);

  const resumeAI = useCallback(async () => {
    dbg('flow', '▶️ RESUME AI: Unmuting mic + resuming playback');
    dbgUpdateState({ isMuted: false, isBuffering: true });
    processorRef.current?.setMuted(false);
    processorRef.current?.setBuffering(true);
    await playerRef.current?.resume();
  }, []);

  return {
    isConnected, isListening, isSpeaking, volume, transcript, error,
    pronunciationScore, isAnalyzing, currentTargetWord, recognizedSpeech, speechMismatch,
    connect, disconnect, setBuffering, pauseAI, resumeAI,
  };
}
