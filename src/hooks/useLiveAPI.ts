import { useState, useCallback, useRef } from 'react';
import { GoogleGenAI, Modality, LiveServerMessage } from "@google/genai";
import { AudioProcessor, AudioPlayer } from '../utils/audioUtils';

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

  // Exact
  for (let i = 0; i < words.length; i++) {
    if (words[i].toLowerCase().replace(/[^a-z]/g, '') === t) return { idx: i, total: words.length };
  }
  // Fuzzy
  let best = -1, bestScore = 0;
  for (let i = 0; i < words.length; i++) {
    const w = words[i].toLowerCase().replace(/[^a-z]/g, '');
    if (w.length < 2) continue;
    const s = levenshteinSimilarity(w, t);
    if (s > bestScore && s > 0.6) { bestScore = s; best = i; }
  }
  return best >= 0 ? { idx: best, total: words.length } : null;
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

  // ═══════════════════════════════════════════════
  // AI reference audio extraction (for Praat comparison)
  // ═══════════════════════════════════════════════

  function getRefChunksForWord(allChunks: string[], word: string | null): string[] {
    if (allChunks.length === 0) return [];

    // AI typically says the target word at the END of its sentence
    // e.g. "Now let's practice the word — analyze" → "analyze" is at the end
    // At 24kHz, each chunk ≈ 0.04s → 75 chunks ≈ 3s (enough for any single word)
    const MAX_REF_CHUNKS = 75;  // ~3 seconds

    if (allChunks.length <= MAX_REF_CHUNKS) {
      console.log(`%c[Praat] 📤 Ref: ${allChunks.length} chunks (~${(allChunks.length * 0.04).toFixed(1)}s) for "${word || 'unknown'}"`, 'color: #818cf8');
      return allChunks;
    }

    // Take last ~3 seconds where the target word is most likely spoken
    const refChunks = allChunks.slice(-MAX_REF_CHUNKS);
    console.log(`%c[Praat] 📤 Ref: last ${refChunks.length}/${allChunks.length} chunks (~${(refChunks.length * 0.04).toFixed(1)}s) for "${word || 'unknown'}"`, 'color: #818cf8');
    return refChunks;
  }

  // ═══════════════════════════════════════════════
  // Praat analysis
  // ═══════════════════════════════════════════════

  const runPraatAnalysis = useCallback(async () => {
    const proc = processorRef.current;
    if (!proc) return;

    // ── Check 1: Has audio? ──
    if (!proc.hasUserAudio()) {
      console.log('%c[Praat] ⏭️ Skip — no user audio buffered', 'color: #888');
      return;
    }

    let userChunks = proc.flushUserBuffer();
    if (userChunks.length === 0) return;

    const sampleRate = proc.getSampleRate();
    const target = targetWordRef.current;
    const rawUserText = userTranscriptRef.current.trim();
    userTranscriptRef.current = '';

    // ── Cap max user buffer: keep only last ~10 seconds ──
    // At 16kHz with 4096 samples/chunk, each chunk ≈ 0.256s → ~40 chunks = ~10s
    // Server-side trimSilence will precisely remove silence, so we just set a generous upper bound
    const MAX_USER_CHUNKS = 40;
    if (userChunks.length > MAX_USER_CHUNKS) {
      console.log(`%c[Praat] ✂️ User buffer too long (${userChunks.length} chunks, ~${(userChunks.length * 4096 / sampleRate).toFixed(1)}s) — trimming to last ${MAX_USER_CHUNKS} chunks (~10s)`, 'color: #f59e0b');
      userChunks = userChunks.slice(-MAX_USER_CHUNKS);
    }

    // ── Check 2: Do we have a target word? ──
    if (!target) {
      console.log('%c[Praat] ⏭️ Skip — no target word set yet', 'color: #888');
      setRecognizedSpeech(null);
      return;
    }

    // ── Check 3: Did user say the target word? ──
    const cleanUserText = rawUserText.replace(/[^a-zA-Z\s]/g, '').trim();
    if (cleanUserText.length >= 2) {
      const match = findWordInText(cleanUserText, target);
      if (!match) {
        console.log(`%c[Praat] ⏭️ Skip — "${cleanUserText}" ≠ "${target}"`, 'color: #f59e0b; font-weight: bold');
        setRecognizedSpeech(null);
        setSpeechMismatch(true);
        // Auto-clear after 3 seconds
        setTimeout(() => setSpeechMismatch(false), 3000);
        return;
      }
      // Matched!
      setRecognizedSpeech(cleanUserText);
      setSpeechMismatch(false);
    } else {
      console.log('%c[Praat] ⏭️ Skip — no usable speech detected', 'color: #888');
      setRecognizedSpeech(null);
      return;
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
        console.log(`%c[Praat] ✅ Done (${((performance.now() - t0) / 1000).toFixed(2)}s) — Overall: ${score!.overall}`, 'color: #34d399; font-weight: bold');
      }

      // ── Step 2: Compare with AI reference ──
      if (score && lastAiChunksRef.current.length > 0) {
        const refChunks = getRefChunksForWord(lastAiChunksRef.current, target);
        if (refChunks.length > 0) {
          const r2 = await fetch('/api/compare-pronunciation', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refChunks, userChunks: chunks, sampleRate, targetWord: target }),
          });
          const d2 = await r2.json();
          if (d2.status === 'success') {
            score.comparison = d2.comparison;
            console.log(`%c[Praat] ✅ Similarity: ${d2.comparison.overallSimilarity}%`, 'color: #34d399');
          }
        }
      }

      // ── Step 3: Update UI + send to AI ──
      if (score) {
        setPronunciationScore(score);

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
          console.log('%c[Praat] 📤 Sending to AI...', 'color: #f472b6; font-weight: bold; font-size: 13px');
          skipNextAnalysisRef.current = true;
          try {
            await sessionRef.current.sendClientContent({
              turns: [{ role: 'user', parts: [{ text: lines.join('\n') }] }],
              turnComplete: true,
            });
            console.log('%c[Praat] ✅ Sent', 'color: #34d399');
          } catch (err) {
            console.error('[Praat] ❌ Send failed:', err);
            skipNextAnalysisRef.current = false;
          }
        }
      }
    } catch (err) {
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
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      processorRef.current = new AudioProcessor();
      playerRef.current = new AudioPlayer((v) => setVolume(v));
      processorRef.current.setBuffering(false); // start with buffering OFF (AI will speak first)

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
                if (extractTimerRef.current) { clearTimeout(extractTimerRef.current); extractTimerRef.current = null; }

                // Clear previous turn transcript for new turn
                aiTranscriptRef.current = '';

                // ── Trigger Praat analysis ──
                if (skipNextAnalysisRef.current) {
                  skipNextAnalysisRef.current = false;
                  isPraatResponseRef.current = true;   // mark this turn as Praat feedback response
                  console.log('%c[Praat] ⏭️ Skip — AI responding to Praat data (will NOT save ref audio)', 'color: #888');
                } else {
                  isPraatResponseRef.current = false;
                  console.log('%c[Praat] 🤖 AI started → running analysis', 'color: #60a5fa; font-weight: bold');
                  runPraatAnalysis();
                }
              }

              // ── Play + buffer ──
              setIsSpeaking(true);
              processorRef.current?.setBuffering(false);  // stop user buffering while AI plays
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
                    console.log(`%c[Echo] 🎯 Target word DETECTED: "${targetWordRef.current}" → "${detected}" — clearing ref`, 'color: #34d399; font-weight: bold');
                    targetWordRef.current = detected;
                    setCurrentTargetWord(detected);
                    lastAiChunksRef.current = [];
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
              setIsSpeaking(false);
              aiTurnActiveRef.current = false;

              // Save AI reference audio for Praat comparison
              // BUT skip saving if this turn was a Praat feedback response (short feedback audio, not a new word)
              if (isPraatResponseRef.current) {
                // Flush AI buffer to discard feedback audio, but don't overwrite the reference
                if (processorRef.current?.hasAiAudio()) {
                  processorRef.current.flushAiBuffer();
                  console.log(`%c[Audio] 🗑️ Discarded Praat feedback audio (keeping previous ref)`, 'color: #888');
                }
                isPraatResponseRef.current = false;
              } else if (processorRef.current?.hasAiAudio()) {
                const newChunks = processorRef.current.flushAiBuffer();
                const existingLen = lastAiChunksRef.current.length;

                // Only overwrite ref if:
                // (a) we don't have a ref yet, or
                // (b) the new turn has MORE chunks (= new substantial teaching turn)
                // This prevents short "try again" turns from overwriting the original teaching ref
                if (existingLen === 0 || newChunks.length > existingLen) {
                  lastAiChunksRef.current = newChunks;
                  lastAiTextRef.current = aiTranscriptRef.current.replace(/\s+/g, ' ').trim();
                  console.log(`%c[Audio] 💾 ${newChunks.length} AI ref chunks saved (replaced ${existingLen})`, 'color: #818cf8');
                } else {
                  console.log(`%c[Audio] ⏭️ Keeping existing ref (${existingLen} chunks) — new turn only had ${newChunks.length} chunks`, 'color: #94a3b8');
                }
              }

              // Start buffering user audio for next analysis
              processorRef.current?.clearUserBuffer();
              processorRef.current?.setBuffering(true);
              console.log('%c[Audio] ⏺️ Buffering ON — waiting for user', 'color: #34d399');
            }

            // ╔═══════════════════════════╗
            // ║  Interrupted               ║
            // ╚═══════════════════════════╝
            if (msg.serverContent?.interrupted) {
              playerRef.current?.stop();
              setIsSpeaking(false);
              aiTurnActiveRef.current = false;
              processorRef.current?.clearUserBuffer();
              processorRef.current?.clearAiBuffer();
              processorRef.current?.setBuffering(true);
              userTranscriptRef.current = '';
              aiTranscriptRef.current = '';
              console.log('%c[Audio] ⚡ Interrupted', 'color: #f59e0b');
            }

            // ╔═══════════════════════════╗
            // ║  User input transcription  ║
            // ╚═══════════════════════════╝
            const inText = (msg as any).serverContent?.inputTranscription?.text;
            if (inText) {
              userTranscriptRef.current += ' ' + inText;
              console.log(`%c[User] 👤 "${inText}"`, 'color: #fbbf24');
            }
          },

          // ────────────────────────────
          onclose: () => {
            setIsConnected(false);
            processorRef.current?.stopRecording();
          },
          onerror: (err) => {
            console.error("Live API Error:", err);
            setError("Connection error.");
            setIsConnected(false);
          }
        }
      });

      sessionRef.current = session;
    } catch (err) {
      console.error("Connect failed:", err);
      setError("Failed to initialize.");
    }
  }, [runPraatAnalysis]);

  // ═══════════════════════════════════════════════
  // Disconnect
  // ═══════════════════════════════════════════════

  const disconnect = useCallback(() => {
    sessionRef.current?.close();
    processorRef.current?.stopRecording();
    playerRef.current?.stop();
    setIsConnected(false);
    setIsSpeaking(false);
  }, []);

  // ── Buffering control for external use (e.g., audio playback) ──
  const setBuffering = useCallback((on: boolean) => {
    processorRef.current?.setBuffering(on);
  }, []);

  // ── AI playback control (pause/resume when user plays comparison audio) ──
  const pauseAI = useCallback(async () => {
    // Mute mic completely — prevents playback audio from reaching Gemini
    processorRef.current?.setMuted(true);
    processorRef.current?.setBuffering(false);
    // Pause AI speech
    await playerRef.current?.suspend();
  }, []);

  const resumeAI = useCallback(async () => {
    // Unmute mic and resume buffering
    processorRef.current?.setMuted(false);
    processorRef.current?.setBuffering(true);
    // Resume AI speech
    await playerRef.current?.resume();
  }, []);

  return {
    isConnected, isListening, isSpeaking, volume, transcript, error,
    pronunciationScore, isAnalyzing, currentTargetWord, recognizedSpeech, speechMismatch,
    connect, disconnect, setBuffering, pauseAI, resumeAI,
  };
}
