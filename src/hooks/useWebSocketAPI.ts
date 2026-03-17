/**
 * China-compatible Live API Hook
 * ================================
 * Replaces useLiveAPI.ts
 * Uses standard WebSockets to communicate with our own Node.js server.
 * The server handles STT (faster-whisper) -> LLM (DeepSeek) -> TTS (Edge TTS).
 */
import { useState, useCallback, useRef, useEffect } from 'react';
import { AudioProcessor, AudioPlayer } from '../utils/audioUtils';
import { dbg, dbgUpdateState, dbgGetState, dbgStateTransition, dbgTimed } from '../utils/debugLogger';
import { PronunciationScore, ComparisonResult } from './useLiveAPI'; // Import types

// ═══════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════

async function extractTargetWord(transcript: string): Promise<string | null> {
  if (transcript.trim().length === 0) return null;
  // A simple heuristic for now (first significant word highlighted in quotes, or just the whole sentence if short)
  const match = transcript.match(/["']([a-zA-Z]+)["']/);
  if (match) return match[1].toLowerCase();
  
  const words = transcript.split(/\s+/).filter(w => /^[a-zA-Z]+$/.test(w));
  if (words.length > 0 && words.length < 3) return words[words.length - 1].toLowerCase();
  
  return null;
}

// ═══════════════════════════════════════════════
// Main Hook
// ═══════════════════════════════════════════════

export function useWebSocketAPI() {
  const [isConnected, setIsConnected] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [volume, setVolume] = useState(0);
  const [transcript, setTranscript] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Praat specific
  const [pronunciationScore, setPronunciationScore] = useState<PronunciationScore | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [currentTargetWord, setCurrentTargetWord] = useState<string | null>(null);
  const [recognizedSpeech, setRecognizedSpeech] = useState<string | null>(null);
  const [speechMismatch, setSpeechMismatch] = useState<boolean>(false);
  const [acousticRepresentation, setAcousticRepresentation] = useState<any | null>(null);
  const [recordingSecondsLeft, setRecordingSecondsLeft] = useState<number | null>(null);

  // Refs
  const wsRef = useRef<WebSocket | null>(null);
  const processorRef = useRef<AudioProcessor | null>(null);
  const playerRef = useRef<AudioPlayer | null>(null);
  
  // Buffers for Praat analysis
  const userFullBufferRef = useRef<string[]>([]);
  const refFullBufferRef = useRef<string[]>([]);
  
  // Debounce timers
  const praatDebounceRef = useRef<NodeJS.Timeout | null>(null);
  const extractTimerRef = useRef<NodeJS.Timeout | null>(null);
  const silenceTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Internal state tracking
  const userTranscriptRef = useRef<string>('');
  const targetWordRef = useRef<string | null>(null);
  const isPlayingRef = useRef<boolean>(false);

  // ═══════════════════════════════════════════════
  // Praat Analysis (Ported from original)
  // ═══════════════════════════════════════════════

  const runPraatAnalysis = useCallback(async (forcedTarget?: string) => {
    setIsAnalyzing(true);
    setError(null);
    setSpeechMismatch(false);
    
    // Copy buffers and wait
    const userChunks = [...userFullBufferRef.current];
    const refChunks = [...refFullBufferRef.current];
    const target = forcedTarget || targetWordRef.current;
    
    if (userChunks.length < 3) {
      console.log('Not enough audio to analyze');
      setIsAnalyzing(false);
      return;
    }

    try {
      if (refChunks.length > 0 && target) {
        // We have reference audio and a target: COMPARE
        const res = await fetch('/api/compare-pronunciation', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refChunks, userChunks, sampleRate: 16000, targetWord: target })
        });
        const data = await res.json();
        
        if (data.status === 'success' && data.comparison) {
          const comp: ComparisonResult = data.comparison;
          setPronunciationScore({
            overall: comp.overallSimilarity,
            pitchStability: comp.pitchScore,
            vowelClarity: comp.formantScore,
            voiceQuality: comp.intensityScore,
            fluency: comp.durationScore,
            details: comp,
            feedback: comp.feedback,
            comparison: comp
          });
          userFullBufferRef.current = []; // clear buffer after success
        }
      } else {
        // No reference audio (yet): JUST ANALYZE USER
        const res = await fetch('/api/analyze-pronunciation', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ audioChunks: userChunks, sampleRate: 16000 })
        });
        const data = await res.json();
        if (data.status === 'success' && data.score) {
          setPronunciationScore(data.score);
        }
      }
    } catch (err: any) {
      console.error('[Praat] Analysis failed:', err);
      setError('Analysis failed: ' + err.message);
    } finally {
      setIsAnalyzing(false);
    }
  }, []);

  // ═══════════════════════════════════════════════
  // WebSocket Connection
  // ═══════════════════════════════════════════════

  const connect = useCallback(async (systemInstruction: string) => {
    try {
      dbg('flow', '🚀 CONNECT: Initializing WebSocket session...');
      setError(null);
      setTranscript('');
      userFullBufferRef.current = [];
      refFullBufferRef.current = [];
      targetWordRef.current = null;
      setCurrentTargetWord(null);

      // Determine WS URL (handles localhost and huggingface spaces smoothly)
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const host = window.location.host;
      const wsUrl = `${protocol}//${host}/ws/chat`;

      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      processorRef.current = new AudioProcessor();
      playerRef.current = new AudioPlayer((v) => setVolume(v));
      processorRef.current.setBuffering(false); // start with buffering OFF (AI will speak first)

      ws.onopen = () => {
        console.log('[WS] Connected to backend server');
        setIsConnected(true);
        // Send start message with instruction
        ws.send(JSON.stringify({
          type: 'start',
          systemInstruction,
          sampleRate: 16000
        }));
      };

      ws.onmessage = async (event) => {
        try {
          const msg = JSON.parse(event.data);
          
          switch (msg.type) {
            case 'ready':
              // Start mic processor
              processorRef.current?.startRecording(async (base64Chunk) => {
                if (!isPlayingRef.current && ws.readyState === WebSocket.OPEN) {
                  // Send to backend for STT/AI
                  ws.send(JSON.stringify({ type: 'audio', data: base64Chunk }));
                  // Also buffer locally for Praat
                  if (processorRef.current?.isBufferingConfigured) {
                    userFullBufferRef.current.push(base64Chunk);
                  }
                }
              });
              setIsListening(true);
              break;

            case 'turn_start':
              setIsSpeaking(true);
              isPlayingRef.current = true;
              processorRef.current?.setBuffering(false); // Pause praat buffering while AI talks
              playerRef.current?.startStreaming();
              // Reset praat reference buffer because AI is saying a new word
              refFullBufferRef.current = []; 
              break;

            case 'ai_audio':
              // Play AI speech
              playerRef.current?.addPCMBuffer(msg.data, msg.sampleRate);
              // ALSO stash the AI speech as Praat Reference audio!
              if (msg.sampleRate === 24000) {
                 // Note: we might need resampling logic if Praat strictly requires 16k, but for now we buffer it
                 refFullBufferRef.current.push(msg.data);
              }
              break;

            case 'ai_transcript':
              setTranscript(prev => prev + '\nEcho: ' + msg.text);
              
              // Extract target word dynamically from what AI just said
              if (extractTimerRef.current) clearTimeout(extractTimerRef.current);
              extractTimerRef.current = setTimeout(async () => {
                const extracted = await extractTargetWord(msg.text);
                if (extracted && extracted !== targetWordRef.current) {
                  console.log(`[DeepSeek] Extracted new target word: "${extracted}"`);
                  targetWordRef.current = extracted;
                  setCurrentTargetWord(extracted);
                }
              }, 500);
              break;

            case 'user_transcript':
              setTranscript(prev => prev + '\nYou: ' + msg.text);
              userTranscriptRef.current += ' ' + msg.text;
              
              // Now that user has spoken, trigger Praat!
              if (praatDebounceRef.current) clearTimeout(praatDebounceRef.current);
              praatDebounceRef.current = setTimeout(() => {
                 console.log("[Praat] Silence detected, triggering analysis...");
                 runPraatAnalysis();
                 // clear transcript after analysis
                 userTranscriptRef.current = ''; 
              }, 1500);
              break;
              
            case 'turn_end':
               // Wait for audio player to actually finish draining its queue
               playerRef.current?.onComplete(() => {
                 setIsSpeaking(false);
                 isPlayingRef.current = false;
                 processorRef.current?.setBuffering(true); // resume buffering for user reply
                 console.log("[WS] AI finished speaking, ready for user.");
               });
               playerRef.current?.flushAndFinish();
               break;

            case 'error':
              console.error("[WS] Backend error:", msg.message);
              setError(msg.message);
              break;
          }
        } catch (e) {
          console.error("Error parsing WS message:", e);
        }
      };

      ws.onclose = () => {
        console.log('[WS] Disconnected');
        disconnect();
      };
      
      ws.onerror = (e) => {
        console.error('[WS] Error:', e);
        setError('Connection error. Is the backend running?');
      };

      // Periodic silence detector for WS events (since we don't have Gemini's native event)
      silenceTimerRef.current = setInterval(() => {
         if (processorRef.current && processorRef.current.isBufferingConfigured && !isPlayingRef.current) {
           const db = processorRef.current.getCurrentVolume();
           // if volume is very low, let's assume they stopped singing/speaking
           // and tell backend to process what we sent!
           if (db < 5 && userFullBufferRef.current.length > 5) {
               console.log("[WS] Silence detected locally, telling backend...");
               if (wsRef.current?.readyState === WebSocket.OPEN) {
                   wsRef.current.send(JSON.stringify({ type: 'user_stopped' }));
               }
           }
         }
      }, 1000);

    } catch (err: any) {
      console.error('Connection failed:', err);
      setError('Connection failed: ' + err.message);
      disconnect();
    }
  }, [runPraatAnalysis]);

  const disconnect = useCallback(() => {
    dbg('flow', '🛑 DISCONNECT');
    wsRef.current?.close();
    processorRef.current?.stopRecording();
    playerRef.current?.stop();
    
    if (praatDebounceRef.current) clearTimeout(praatDebounceRef.current);
    if (extractTimerRef.current) clearTimeout(extractTimerRef.current);
    if (silenceTimerRef.current) clearInterval(silenceTimerRef.current);
    
    setIsConnected(false);
    setIsSpeaking(false);
    setIsListening(false);
  }, []);

  const setBuffering = useCallback((on: boolean) => {
    processorRef.current?.setBuffering(on);
  }, []);

  const pauseAI = useCallback(async () => {
    processorRef.current?.setMuted(true);
    processorRef.current?.setBuffering(false);
    await playerRef.current?.suspend();
    isPlayingRef.current = true; // fake 
  }, []);

  const resumeAI = useCallback(async () => {
    processorRef.current?.setMuted(false);
    processorRef.current?.setBuffering(true);
    await playerRef.current?.resume();
    isPlayingRef.current = false;
  }, []);

  return {
    isConnected, isListening, isSpeaking, volume, transcript, error,
    pronunciationScore, isAnalyzing, currentTargetWord, recognizedSpeech, speechMismatch,
    acousticRepresentation, recordingSecondsLeft,
    connect, disconnect, setBuffering, pauseAI, resumeAI,
  };
}
