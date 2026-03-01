import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Mic, MicOff, Send, MessageSquare, Shield, Zap, Info, History, X, User, Headphones, BookOpen, CheckCircle2, Award, Activity, BarChart3, Volume2, AudioLines } from 'lucide-react';
import { useLiveAPI } from './hooks/useLiveAPI';
import { AudioVisualizer } from './components/AudioVisualizer';
import { TalkingHead } from './components/TalkingHead';
import { cn } from './utils/cn';
import { generateDebaterImage } from './services/imageService';

const TRAINING_LEVELS = [
  { id: "daily", label: "Daily Conversation", description: "Common words used in everyday life." },
  { id: "business", label: "Business English", description: "Professional vocabulary for the workplace." },
  { id: "academic", label: "Academic Research", description: "Advanced terms for study and science." },
  { id: "tech", label: "Technology & AI", description: "Modern tech terminology and concepts." }
];

export default function App() {
  const { isConnected, isSpeaking, volume, transcript, error, connect, disconnect, pronunciationScore, isAnalyzing, currentTargetWord } = useLiveAPI();
  const [selectedLevel, setSelectedLevel] = useState<string | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const [debaterImage, setDebaterImage] = useState<string | null>(null);
  const [isGeneratingImage, setIsGeneratingImage] = useState(false);
  const [masteredWords, setMasteredWords] = useState<{ word: string, score: number }[]>([]);
  const [showDashboard, setShowDashboard] = useState(false);
  const startTimeRef = useRef<number>(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Fetch initial progress
  useEffect(() => {
    console.log("[EchoMind] Fetching initial progress...");
    fetch('/api/progress')
      .then(res => res.json())
      .then(data => {
        console.log("[EchoMind] Progress data received:", data);
        setMasteredWords(data.map((item: any) => ({ word: item.word, score: item.score })));
      })
      .catch(err => console.error("[EchoMind] Failed to fetch progress:", err));
  }, []);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [transcript]);

  // Track response time for the algorithm
  useEffect(() => {
    if (isSpeaking) {
      startTimeRef.current = Date.now();
    }
  }, [isSpeaking]);

  // Extract mastered words and send to backend
  useEffect(() => {
    const lastMessage = transcript[transcript.length - 1];
    if (lastMessage?.role === 'model' && /MASTERED:\s*\[?(\w+)\]?/i.test(lastMessage.text)) {
      const match = lastMessage.text.match(/MASTERED:\s*\[?(\w+)\]?/i);
      if (match && match[1]) {
        const word = match[1].toLowerCase();
        const responseTime = Date.now() - startTimeRef.current;

        console.log(`[EchoMind] Word Mastered Detected: ${word}, Response Time: ${responseTime}ms`);

        // Call backend to calculate and store score
        fetch('/api/score', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            word,
            accuracy: 0.95, // Heuristic: if model says mastered, accuracy is high
            usageCorrect: true,
            responseTimeMs: responseTime,
            category: selectedLevel
          })
        })
          .then(res => res.json())
          .then(data => {
            if (data.status === 'success') {
              setMasteredWords(prev => {
                const exists = prev.find(w => w.word === word);
                if (exists) {
                  return prev.map(w => w.word === word ? { word, score: data.record.score } : w);
                }
                return [...prev, { word, score: data.record.score }];
              });
            }
          })
          .catch(err => console.error("[EchoMind] API Error:", err));
      }
    }
  }, [transcript]);

  const loadNewPersona = async () => {
    setIsGeneratingImage(true);
    const img = await generateDebaterImage();
    setDebaterImage(img);
    setIsGeneratingImage(false);
  };

  // Pre-generate image on mount
  useEffect(() => {
    loadNewPersona();
  }, []);

  // Refresh image when topic changes
  useEffect(() => {
    if (selectedLevel && !isConnected) {
      loadNewPersona();
    }
  }, [selectedLevel]);

  const handleStartTraining = async () => {
    if (!selectedLevel) return;
    setIsStarting(true);

    const levelInfo = TRAINING_LEVELS.find(l => l.id === selectedLevel);

    const systemInstruction = `You are "Echo", a specialized English Listening & Vocabulary Coach. 
    Your mission is to help the user learn and memorize new English words PURELY through listening.
    
    CRITICAL RULES:
    1. NEVER spell the words. Do not say "A-P-P-L-E". 
    2. Focus on the SOUND and the MEANING.
    3. Do not show the spelling in your speech.
    4. Keep the conversation natural and encouraging.
    
    TRAINING ALGORITHM:
    a. Introduce a new word from the category: "${levelInfo?.label}".
    b. Pronounce it clearly, then explain its meaning and use it in a sentence.
    c. Ask the user to repeat the word.
    d. Listen to the user's pronunciation. If it's correct, ask them to use it in a simple sentence.
    e. If they succeed in both repetition and usage, confirm they have "Mastered" the word.
    f. When a word is mastered, you MUST end your turn with the hidden tag "MASTERED: [word]" (e.g., MASTERED: resilient).
    
    ECHO PROTOCOL (for pronunciation practice):
    - When asking the user to repeat a word, ALWAYS use the phrase "repeat after me" followed by the word.
      Example: "Now, repeat after me... resilient."
    - Say the target word CLEARLY and SLOWLY at the END of your turn, so the user hears it last before echoing.
    - If the user says extra words beyond the target, focus ONLY on whether they pronounced the target word correctly.
    - If the user interrupts, respond naturally then return to the echo exercise by saying "Let's try again. Repeat after me..." followed by the word.
    
    PRONUNCIATION FEEDBACK — ABSOLUTE RULES:
    
    🚫 NEVER ANALYZE PRONUNCIATION YOURSELF. You CANNOT judge pronunciation. You are NOT a pronunciation expert.
    You MUST wait for the system to provide objective data. If you make up pronunciation feedback, you will confuse the student.
    
    WHEN THE USER ECHOES A WORD:
    - Say ONLY: "I heard you! Let me check the analysis." or "Got it! One moment..." (ONE short sentence, NO evaluation)
    - ❌ ABSOLUTELY FORBIDDEN: "Great pronunciation!", "That sounded good!", "Nice try!", "Your pitch was...", "Your vowels..." 
    - ❌ NEVER say anything about pitch, vowels, clarity, intonation, or pronunciation quality on your own.
    - ❌ NEVER make up scores, percentages, or analysis data.
    
    WHEN YOU RECEIVE "[PRONUNCIATION_ANALYSIS_RESULT]":
    - This is REAL data from Praat acoustic analysis software. ONLY THEN may you discuss pronunciation.
    - Base ALL feedback on the numbers provided:
      * Overall score > 70: "That was really good!"
      * Overall score 40-70: "Not bad, but let's work on some areas."
      * Overall score < 40: "Let's try that again."
      * Cite specific scores (pitch %, vowel %, pace) in your feedback.
    - Be encouraging. Mention what they did WELL first, then what to improve.
    - Keep feedback to 2-3 sentences.
    - If similarity < 60%, ask them to try again. If >= 60%, move on.
    
    IF YOU DO NOT RECEIVE "[PRONUNCIATION_ANALYSIS_RESULT]":
    - It means the system decided no analysis was needed (e.g., user was making a sentence, not echoing).
    - In that case, just continue the lesson naturally. Do NOT provide any pronunciation feedback.
    
    Start by introducing yourself and the first word for the "${levelInfo?.label}" level.`;

    await connect(systemInstruction);
    setIsStarting(false);
  };

  return (
    <div className="min-h-screen bg-[#050505] text-zinc-100 font-sans selection:bg-blue-500/30 overflow-hidden flex flex-col">
      {/* Background Atmosphere */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <motion.div
          animate={isSpeaking ? {
            scale: [1, 1.1, 1],
            opacity: [0.05, 0.08, 0.05]
          } : {}}
          transition={{ duration: 4, repeat: Infinity }}
          className="absolute top-[-10%] left-[-10%] w-[50%] h-[50%] bg-blue-900/5 blur-[120px] rounded-full"
        />
        <div className="absolute bottom-[-10%] right-[-10%] w-[50%] h-[50%] bg-indigo-900/5 blur-[120px] rounded-full" />
        <div className="absolute inset-0 bg-[url('https://grainy-gradients.vercel.app/noise.svg')] opacity-20 mix-blend-overlay" />
      </div>

      <main className="relative z-10 flex-1 flex flex-col max-w-7xl mx-auto w-full px-6 py-8 overflow-hidden">
        {/* Header */}
        <header className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center">
              <Headphones className="w-5 h-5 text-blue-400" />
            </div>
            <div>
              <h1 className="text-xl font-semibold tracking-tight">EchoMind</h1>
              <p className="text-[10px] text-zinc-500 uppercase tracking-[0.3em] font-mono">Pure Auditory Training // Live</p>
            </div>
          </div>

          <div className="flex items-center gap-4">
            <button
              onClick={() => setShowDashboard(!showDashboard)}
              className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-zinc-900 border border-white/5 hover:bg-zinc-800 transition-colors"
            >
              <Award className="w-3.5 h-3.5 text-yellow-500" />
              <span className="text-xs font-bold text-zinc-300">{masteredWords.length} Mastered</span>
            </button>
            {isConnected && (
              <button
                onClick={disconnect}
                className="px-4 py-2 rounded-full bg-white/5 border border-white/10 text-zinc-400 text-xs font-medium hover:bg-white/10 transition-all flex items-center gap-2"
              >
                <X className="w-3.5 h-3.5" />
                End Session
              </button>
            )}
          </div>
        </header>

        <AnimatePresence>
          {showDashboard && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className="mb-8 overflow-hidden"
            >
              <div className="p-6 rounded-3xl bg-zinc-900/50 border border-white/5 backdrop-blur-xl">
                <div className="flex items-center justify-between mb-6">
                  <h3 className="text-lg font-semibold flex items-center gap-2">
                    <Award className="w-5 h-5 text-yellow-500" />
                    Mastery Dashboard
                  </h3>
                  <button onClick={() => setShowDashboard(false)} className="text-zinc-500 hover:text-white">
                    <X className="w-4 h-4" />
                  </button>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
                  {masteredWords.map((item, idx) => (
                    <div key={idx} className="p-4 rounded-2xl bg-black/40 border border-white/5 flex flex-col items-center gap-2">
                      <span className="text-xs font-bold uppercase tracking-widest text-zinc-400">{item.word}</span>
                      <div className="w-full bg-zinc-800 h-1.5 rounded-full overflow-hidden">
                        <motion.div
                          initial={{ width: 0 }}
                          animate={{ width: `${item.score}%` }}
                          className={cn(
                            "h-full rounded-full",
                            item.score > 80 ? "bg-emerald-500" : item.score > 50 ? "bg-blue-500" : "bg-yellow-500"
                          )}
                        />
                      </div>
                      <span className="text-[10px] font-mono text-zinc-500">{item.score}% Mastery</span>
                    </div>
                  ))}
                  {masteredWords.length === 0 && (
                    <p className="col-span-full text-center py-8 text-zinc-600 italic">Start training to see your progress here.</p>
                  )}
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {!isConnected ? (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex-1 flex flex-col items-center justify-center max-w-2xl mx-auto text-center"
          >
            <div className="mb-10 relative group">
              <div className="absolute inset-0 bg-blue-500/20 blur-3xl rounded-full" />
              <div className="relative w-32 h-32 rounded-3xl overflow-hidden border border-white/10 bg-zinc-900 flex items-center justify-center shadow-2xl">
                {isGeneratingImage ? (
                  <div className="flex flex-col items-center gap-2">
                    <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                  </div>
                ) : debaterImage ? (
                  <img src={debaterImage} alt="Coach" className="w-full h-full object-cover" />
                ) : (
                  <User className="w-12 h-12 text-zinc-700" />
                )}
              </div>

              <button
                onClick={loadNewPersona}
                disabled={isGeneratingImage}
                className="absolute -bottom-2 -right-2 w-8 h-8 rounded-full bg-zinc-800 border border-white/10 flex items-center justify-center text-zinc-400 hover:text-white hover:bg-zinc-700 transition-all shadow-lg"
                title="Change Coach"
              >
                <History className={cn("w-4 h-4", isGeneratingImage && "animate-spin")} />
              </button>
            </div>

            <h2 className="text-4xl font-light mb-6 tracking-tight">Train Your Ears</h2>
            <p className="text-zinc-400 text-lg leading-relaxed mb-10">
              Master English vocabulary through pure sound. No spelling, no reading—just listening and speaking.
              Select a category to begin your session with Coach Echo.
            </p>

            {masteredWords.length > 0 && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="mb-10 p-4 rounded-2xl bg-blue-500/5 border border-blue-500/10 flex items-center gap-6"
              >
                <div className="text-left">
                  <p className="text-[10px] uppercase tracking-widest font-bold text-blue-400 mb-1">Learning Stats</p>
                  <p className="text-2xl font-light text-white">{masteredWords.length} <span className="text-sm text-zinc-500">Words Mastered</span></p>
                </div>
                <div className="h-10 w-px bg-white/10" />
                <div className="text-left">
                  <p className="text-[10px] uppercase tracking-widest font-bold text-emerald-400 mb-1">Avg. Mastery</p>
                  <p className="text-2xl font-light text-white">
                    {Math.round(masteredWords.reduce((acc, curr) => acc + curr.score, 0) / masteredWords.length)}%
                  </p>
                </div>
                <button
                  onClick={() => setShowDashboard(true)}
                  className="ml-auto text-xs font-bold text-blue-400 hover:text-blue-300 transition-colors"
                >
                  View Details →
                </button>
              </motion.div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 w-full mb-10">
              {TRAINING_LEVELS.map((level) => (
                <button
                  key={level.id}
                  onClick={() => setSelectedLevel(level.id)}
                  className={cn(
                    "p-5 rounded-2xl border text-left transition-all duration-300 group relative overflow-hidden",
                    selectedLevel === level.id
                      ? "bg-blue-500/10 border-blue-500/50 text-blue-100"
                      : "bg-zinc-900/30 border-zinc-800/50 text-zinc-400 hover:border-zinc-700 hover:bg-zinc-900/50"
                  )}
                >
                  <div className="relative z-10">
                    <div className="flex items-center justify-between mb-2">
                      <span className="font-bold text-sm uppercase tracking-wider">{level.label}</span>
                      {selectedLevel === level.id && <CheckCircle2 className="w-4 h-4 text-blue-400" />}
                    </div>
                    <p className="text-xs text-zinc-500 leading-relaxed">{level.description}</p>
                  </div>
                </button>
              ))}
            </div>

            <button
              disabled={!selectedLevel || isStarting}
              onClick={handleStartTraining}
              className={cn(
                "w-full py-5 rounded-2xl font-bold text-lg transition-all flex items-center justify-center gap-3",
                selectedLevel && !isStarting
                  ? "bg-white text-black hover:scale-[1.02] active:scale-[0.98] shadow-xl"
                  : "bg-zinc-800 text-zinc-500 cursor-not-allowed"
              )}
            >
              {isStarting ? (
                <div className="w-6 h-6 border-2 border-black/30 border-t-black rounded-full animate-spin" />
              ) : (
                <>
                  <Mic className="w-5 h-5" />
                  Start Listening Session
                </>
              )}
            </button>

            {error && <p className="mt-6 text-red-400 text-sm font-mono bg-red-400/10 px-4 py-2 rounded-lg border border-red-400/20">{error}</p>}
          </motion.div>
        ) : (
          <div className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-8 overflow-hidden">
            {/* Left Column: AI Visual & Controls */}
            <div className="lg:col-span-5 flex flex-col gap-6 overflow-hidden">
              <div className="relative flex-1 rounded-[2rem] overflow-hidden border border-white/10 bg-zinc-900 shadow-2xl group">
                <TalkingHead
                  image={debaterImage}
                  isSpeaking={isSpeaking}
                  volume={volume}
                />

                {/* Status Badge */}
                <div className={cn(
                  "absolute top-6 left-6 flex items-center gap-2 px-3 py-1.5 rounded-full bg-black/60 backdrop-blur-md border transition-all duration-500",
                  isSpeaking ? "border-blue-500/50 shadow-[0_0_15px_rgba(59,130,246,0.3)]" : "border-white/10"
                )}>
                  <div className="relative">
                    <div className={cn("w-2 h-2 rounded-full", isSpeaking ? "bg-blue-500" : "bg-zinc-500")} />
                    {isSpeaking && (
                      <motion.div
                        animate={{ scale: [1, 2], opacity: [0.5, 0] }}
                        transition={{ duration: 1.5, repeat: Infinity }}
                        className="absolute inset-0 bg-blue-500 rounded-full"
                      />
                    )}
                  </div>
                  <span className={cn(
                    "text-[10px] uppercase tracking-widest font-bold transition-colors duration-500",
                    isSpeaking ? "text-blue-400" : "text-white"
                  )}>
                    {isSpeaking ? "Echo is speaking" : "Echo is listening"}
                  </span>
                </div>

                {/* Neural Pulse Indicator */}
                {isSpeaking && (
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: [0, 0.05, 0] }}
                    transition={{ duration: 3, repeat: Infinity }}
                    className="absolute inset-0 bg-blue-500 pointer-events-none"
                  />
                )}

                <div className="absolute bottom-6 right-6 text-[10px] text-zinc-600 font-mono uppercase tracking-widest">
                  Auditory Engine // Active
                </div>
              </div>

              {/* Visualizer Card */}
              <div className="p-6 rounded-3xl bg-zinc-900/50 border border-white/5 backdrop-blur-xl">
                <AudioVisualizer isActive={isSpeaking} color={isSpeaking ? "#3b82f6" : "#3f3f46"} />
                <div className="mt-4 flex items-center justify-center gap-3 text-[10px] uppercase tracking-[0.2em] font-bold text-zinc-500">
                  <Mic className="w-3 h-3" />
                  Live Audio Stream Active
                </div>
              </div>

              {/* ===== Praat Pronunciation Score Panel ===== */}
              <AnimatePresence>
                {(pronunciationScore || isAnalyzing) && (
                  <motion.div
                    initial={{ opacity: 0, y: 20, height: 0 }}
                    animate={{ opacity: 1, y: 0, height: 'auto' }}
                    exit={{ opacity: 0, y: -10, height: 0 }}
                    className="overflow-hidden"
                  >
                    <div className="p-6 rounded-3xl bg-zinc-900/50 border border-white/5 backdrop-blur-xl">
                      <div className="flex items-center justify-between mb-5">
                        <div className="flex items-center gap-2">
                          <div className="w-7 h-7 rounded-lg bg-violet-500/10 flex items-center justify-center">
                            <Activity className="w-4 h-4 text-violet-400" />
                          </div>
                          <span className="text-[10px] uppercase tracking-[0.25em] font-bold text-zinc-400">
                            {currentTargetWord ? 'Echo Pronunciation Analysis' : 'Pronunciation Analysis'}
                          </span>
                        </div>
                        {isAnalyzing && (
                          <div className="flex items-center gap-2">
                            <div className="w-3 h-3 border-2 border-violet-500 border-t-transparent rounded-full animate-spin" />
                            <span className="text-[10px] text-violet-400 font-bold uppercase tracking-wider">Analyzing...</span>
                          </div>
                        )}
                      </div>

                      {pronunciationScore && !isAnalyzing && (
                        <>
                          {/* Overall Score */}
                          <div className="flex items-center gap-4 mb-6">
                            <div className={cn(
                              "w-16 h-16 rounded-2xl flex items-center justify-center text-2xl font-bold border",
                              pronunciationScore.overall >= 80 ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-400" :
                                pronunciationScore.overall >= 60 ? "bg-blue-500/10 border-blue-500/30 text-blue-400" :
                                  pronunciationScore.overall >= 40 ? "bg-yellow-500/10 border-yellow-500/30 text-yellow-400" :
                                    "bg-red-500/10 border-red-500/30 text-red-400"
                            )}>
                              {pronunciationScore.overall}
                            </div>
                            <div>
                              <p className="text-sm font-semibold text-zinc-200">Overall Score</p>
                              <p className="text-[10px] text-zinc-500 uppercase tracking-wider">
                                {pronunciationScore.overall >= 80 ? 'Excellent' :
                                  pronunciationScore.overall >= 60 ? 'Good' :
                                    pronunciationScore.overall >= 40 ? 'Fair' : 'Needs Practice'}
                              </p>
                            </div>
                          </div>

                          {/* Score Bars */}
                          <div className="space-y-3 mb-5">
                            {[
                              { label: 'Pitch Stability', value: pronunciationScore.pitchStability, icon: AudioLines, color: 'blue' },
                              { label: 'Vowel Clarity', value: pronunciationScore.vowelClarity, icon: Volume2, color: 'violet' },
                              { label: 'Voice Quality', value: pronunciationScore.voiceQuality, icon: Mic, color: 'emerald' },
                              { label: 'Fluency', value: pronunciationScore.fluency, icon: BarChart3, color: 'amber' },
                            ].map(({ label, value, icon: Icon, color }) => (
                              <div key={label} className="flex items-center gap-3">
                                <Icon className={`w-3.5 h-3.5 text-${color}-400 shrink-0`} />
                                <span className="text-[10px] text-zinc-400 font-medium w-24 shrink-0 uppercase tracking-wider">{label}</span>
                                <div className="flex-1 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                                  <motion.div
                                    initial={{ width: 0 }}
                                    animate={{ width: `${value}%` }}
                                    transition={{ duration: 0.8, ease: 'easeOut' }}
                                    className={cn(
                                      "h-full rounded-full",
                                      value >= 80 ? 'bg-emerald-500' : value >= 60 ? 'bg-blue-500' : value >= 40 ? 'bg-yellow-500' : 'bg-red-500'
                                    )}
                                  />
                                </div>
                                <span className="text-[10px] font-mono text-zinc-500 w-8 text-right">{value}</span>
                              </div>
                            ))}
                          </div>

                          {/* Feedback */}
                          {pronunciationScore.feedback.length > 0 && (
                            <div className="space-y-2">
                              {pronunciationScore.feedback.map((fb: string, i: number) => (
                                <motion.p
                                  key={i}
                                  initial={{ opacity: 0, x: -10 }}
                                  animate={{ opacity: 1, x: 0 }}
                                  transition={{ delay: i * 0.1 }}
                                  className="text-xs text-zinc-400 leading-relaxed pl-3 border-l-2 border-violet-500/30"
                                >
                                  {fb}
                                </motion.p>
                              ))}
                            </div>
                          )}

                          {/* ===== Intonation Comparison Section ===== */}
                          {pronunciationScore.comparison && pronunciationScore.comparison.overallSimilarity > 0 && (
                            <motion.div
                              initial={{ opacity: 0, y: 10 }}
                              animate={{ opacity: 1, y: 0 }}
                              className="mt-6 pt-5 border-t border-white/5"
                            >
                              {/* Comparison Header */}
                              <div className="flex items-center gap-2 mb-4">
                                <div className="w-6 h-6 rounded-lg bg-indigo-500/10 flex items-center justify-center">
                                  <AudioLines className="w-3.5 h-3.5 text-indigo-400" />
                                </div>
                                <span className="text-[10px] uppercase tracking-[0.25em] font-bold text-indigo-400">
                                  Intonation Comparison
                                </span>
                              </div>

                              {/* Overall Similarity */}
                              <div className="flex items-center gap-4 mb-5">
                                <div className={cn(
                                  "w-14 h-14 rounded-2xl flex items-center justify-center text-xl font-bold border",
                                  pronunciationScore.comparison.overallSimilarity >= 70 ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-400" :
                                    pronunciationScore.comparison.overallSimilarity >= 40 ? "bg-blue-500/10 border-blue-500/30 text-blue-400" :
                                      "bg-orange-500/10 border-orange-500/30 text-orange-400"
                                )}>
                                  {pronunciationScore.comparison.overallSimilarity}%
                                </div>
                                <div>
                                  <p className="text-sm font-semibold text-zinc-200">Similarity Match</p>
                                  <p className="text-[10px] text-zinc-500 uppercase tracking-wider">
                                    {pronunciationScore.comparison.overallSimilarity >= 70 ? 'Very Similar' :
                                      pronunciationScore.comparison.overallSimilarity >= 40 ? 'Somewhat Similar' : 'Needs Improvement'}
                                  </p>
                                </div>
                              </div>

                              {/* Pitch Contour Visualization */}
                              {pronunciationScore.comparison.pitchContour.ref.length > 0 && (
                                <div className="mb-5 p-4 rounded-xl bg-zinc-800/50 border border-white/5">
                                  <p className="text-[9px] uppercase tracking-[0.2em] font-bold text-zinc-500 mb-3">Pitch Contour</p>
                                  <div className="relative h-16">
                                    {/* Reference pitch line (blue) */}
                                    <svg className="absolute inset-0 w-full h-full" viewBox="0 0 100 100" preserveAspectRatio="none">
                                      {(() => {
                                        const refPoints = pronunciationScore.comparison!.pitchContour.ref;
                                        const userPoints = pronunciationScore.comparison!.pitchContour.user;
                                        const allPoints = [...refPoints, ...userPoints].filter(v => v > 0);
                                        if (allPoints.length === 0) return null;
                                        const maxP = Math.max(...allPoints);
                                        const minP = Math.min(...allPoints);
                                        const range = maxP - minP || 1;

                                        const toY = (v: number) => v > 0 ? 90 - ((v - minP) / range) * 80 : 90;
                                        const toX = (i: number, len: number) => (i / (len - 1)) * 100;

                                        const refPath = refPoints.map((v, i) => `${i === 0 ? 'M' : 'L'}${toX(i, refPoints.length)},${toY(v)}`).join(' ');
                                        const userPath = userPoints.map((v, i) => `${i === 0 ? 'M' : 'L'}${toX(i, userPoints.length)},${toY(v)}`).join(' ');

                                        return (
                                          <>
                                            <path d={refPath} fill="none" stroke="#60a5fa" strokeWidth="2" strokeLinecap="round" opacity="0.8" />
                                            <path d={userPath} fill="none" stroke="#fbbf24" strokeWidth="2" strokeLinecap="round" opacity="0.8" strokeDasharray="4,3" />
                                          </>
                                        );
                                      })()}
                                    </svg>
                                  </div>
                                  <div className="flex items-center justify-center gap-6 mt-2">
                                    <div className="flex items-center gap-1.5">
                                      <div className="w-4 h-0.5 bg-blue-400 rounded" />
                                      <span className="text-[9px] text-zinc-500">AI Reference</span>
                                    </div>
                                    <div className="flex items-center gap-1.5">
                                      <div className="w-4 h-0.5 bg-amber-400 rounded" style={{ backgroundImage: 'repeating-linear-gradient(90deg, #fbbf24, #fbbf24 4px, transparent 4px, transparent 7px)' }} />
                                      <span className="text-[9px] text-zinc-500">Your Speech</span>
                                    </div>
                                  </div>
                                </div>
                              )}

                              {/* Comparison Metrics */}
                              <div className="space-y-2.5 mb-4">
                                {[
                                  { label: 'Pitch Pattern', value: Math.max(0, Math.round(pronunciationScore.comparison.pitchCorrelation * 100)), color: 'blue' },
                                  { label: 'Vowel Match', value: Math.round((pronunciationScore.comparison.f1Similarity + pronunciationScore.comparison.f2Similarity) / 2), color: 'violet' },
                                  { label: 'Speaking Pace', value: Math.max(0, Math.round(100 - Math.abs(pronunciationScore.comparison.durationRatio - 1) * 100)), color: 'emerald' },
                                  { label: 'Stress Pattern', value: Math.max(0, Math.round(pronunciationScore.comparison.intensityCorrelation * 100)), color: 'amber' },
                                ].map(({ label, value, color }) => (
                                  <div key={label} className="flex items-center gap-3">
                                    <span className="text-[10px] text-zinc-400 font-medium w-24 shrink-0 uppercase tracking-wider">{label}</span>
                                    <div className="flex-1 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                                      <motion.div
                                        initial={{ width: 0 }}
                                        animate={{ width: `${value}%` }}
                                        transition={{ duration: 0.8, ease: 'easeOut' }}
                                        className={cn(
                                          "h-full rounded-full",
                                          value >= 70 ? 'bg-emerald-500' : value >= 40 ? 'bg-blue-500' : 'bg-orange-500'
                                        )}
                                      />
                                    </div>
                                    <span className="text-[10px] font-mono text-zinc-500 w-10 text-right">{value}%</span>
                                  </div>
                                ))}
                              </div>

                              {/* Comparison Feedback */}
                              {pronunciationScore.comparison.feedback.length > 0 && (
                                <div className="space-y-2">
                                  {pronunciationScore.comparison.feedback.map((fb: string, i: number) => (
                                    <motion.p
                                      key={`comp-${i}`}
                                      initial={{ opacity: 0, x: -10 }}
                                      animate={{ opacity: 1, x: 0 }}
                                      transition={{ delay: i * 0.1 }}
                                      className="text-xs text-zinc-400 leading-relaxed pl-3 border-l-2 border-indigo-500/30"
                                    >
                                      {fb}
                                    </motion.p>
                                  ))}
                                </div>
                              )}
                            </motion.div>
                          )}
                        </>
                      )}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {/* Right Column: Transcript */}
            <div className="lg:col-span-7 flex flex-col gap-6 overflow-hidden">
              {/* Quick Stats Header */}
              <div className="flex items-center justify-between p-4 rounded-2xl bg-zinc-900/30 border border-white/5">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-lg bg-blue-500/10 flex items-center justify-center">
                    <Award className="w-4 h-4 text-blue-400" />
                  </div>
                  <div>
                    <p className="text-[10px] uppercase tracking-widest font-bold text-zinc-500">Session Progress</p>
                    <p className="text-xs font-medium text-zinc-300">{masteredWords.length} Words Mastered</p>
                  </div>
                </div>
                <button
                  onClick={() => setShowDashboard(true)}
                  className="text-[10px] uppercase tracking-widest font-bold text-blue-400 hover:text-blue-300 transition-colors"
                >
                  Open Dashboard
                </button>
              </div>

              <div
                ref={scrollRef}
                className="flex-1 overflow-y-auto space-y-6 pr-4 scrollbar-thin scrollbar-thumb-zinc-800 mask-fade-bottom"
              >
                <AnimatePresence mode="popLayout">
                  {transcript.length === 0 && (
                    <motion.div
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      className="h-full flex flex-col items-center justify-center text-zinc-600 italic text-center px-12"
                    >
                      <Headphones className="w-12 h-12 mb-6 opacity-10" />
                      <p className="text-lg font-light">The session is ready. Echo is waiting to introduce your first word.</p>
                    </motion.div>
                  )}
                  {transcript.map((msg, i) => {
                    // Filter out the MASTERED tag from the UI to keep it clean
                    const cleanText = msg.text.replace(/MASTERED:\s*\w+/g, '').trim();
                    if (!cleanText && msg.role === 'model') return null;

                    return (
                      <motion.div
                        key={i}
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        className={cn(
                          "flex flex-col gap-2 max-w-[85%]",
                          msg.role === 'user' ? "ml-auto items-end" : "items-start"
                        )}
                      >
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-[10px] uppercase tracking-widest font-bold text-zinc-500">
                            {msg.role === 'user' ? 'You' : 'Coach Echo'}
                          </span>
                        </div>
                        <div className={cn(
                          "p-5 rounded-2xl text-sm leading-relaxed shadow-sm",
                          msg.role === 'user'
                            ? "bg-white text-black font-medium"
                            : "bg-zinc-900 border border-white/5 text-zinc-200"
                        )}>
                          {cleanText}
                        </div>
                      </motion.div>
                    );
                  })}
                </AnimatePresence>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* Footer Meta */}
      <footer className="p-6 flex justify-between items-center text-[10px] text-zinc-600 uppercase tracking-[0.2em] font-mono border-t border-white/5 bg-black/50 backdrop-blur-sm">
        <div className="flex gap-6">
          <span>Status: {isConnected ? 'Training' : 'Standby'}</span>
          <span>Mode: Pure Auditory Memory</span>
        </div>
        <div>
          © 2026 EchoMind Labs
        </div>
      </footer>

      <style>{`
        .mask-fade-bottom {
          mask-image: linear-gradient(to bottom, black 80%, transparent 100%);
        }
      `}</style>
    </div>
  );
}
