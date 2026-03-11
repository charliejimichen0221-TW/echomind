import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import fs from 'fs';
import { analyzePronunciation, comparePronunciation } from './praatService.js';

const app = express();
const PORT = 3000;

app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));

// ===== Data directory setup =====
const DATA_DIR = path.join(process.cwd(), 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// In-memory database for demo purposes
interface MasteryRecord {
  word: string;
  score: number;
  attempts: number;
  lastTested: number;
  category: string;
}

let userProgress: Record<string, MasteryRecord> = {
  'resilient': {
    word: 'resilient',
    score: 85,
    attempts: 3,
    lastTested: Date.now() - 86400000,
    category: 'daily'
  },
  'innovation': {
    word: 'innovation',
    score: 92,
    attempts: 5,
    lastTested: Date.now() - 3600000,
    category: 'tech'
  },
  'paradigm': {
    word: 'paradigm',
    score: 64,
    attempts: 2,
    lastTested: Date.now(),
    category: 'academic'
  }
};

/**
 * Auditory Memory Algorithm
 * Quantifies how well a user has "remembered" the sound and usage of a word.
 */
function calculateMasteryScore(accuracy: number, usageCorrect: boolean, responseTimeMs: number): number {
  // Accuracy: 0.0 to 1.0 (from Gemini's evaluation)
  // Usage: boolean
  // Response Time: Faster is better. Assume 1500ms is "perfect", 8000ms is "slow".

  const accuracyWeight = 0.5;
  const usageWeight = 0.35;
  const speedWeight = 0.15;

  const speedFactor = Math.max(0, Math.min(1, 1 - (responseTimeMs - 1500) / 6500));
  const usageFactor = usageCorrect ? 1 : 0;

  const score = (accuracy * accuracyWeight) + (usageFactor * usageWeight) + (speedFactor * speedWeight);
  return Math.round(score * 100);
}

// API Routes
app.get('/api/progress', (req, res) => {
  res.json(Object.values(userProgress));
});

app.post('/api/score', (req, res) => {
  const { word, accuracy, usageCorrect, responseTimeMs, category } = req.body;

  if (!word) {
    return res.status(400).json({ error: 'Word is required' });
  }

  const newScore = calculateMasteryScore(accuracy || 0.8, usageCorrect ?? true, responseTimeMs || 3000);

  const existing = userProgress[word.toLowerCase()];
  if (existing) {
    // Update existing record: weighted average of scores
    existing.score = Math.round((existing.score + newScore) / 2);
    existing.attempts += 1;
    existing.lastTested = Date.now();
  } else {
    userProgress[word.toLowerCase()] = {
      word: word.toLowerCase(),
      score: newScore,
      attempts: 1,
      lastTested: Date.now(),
      category: category || 'general'
    };
  }

  res.json({
    status: 'success',
    record: userProgress[word.toLowerCase()],
    calculatedScore: newScore
  });
});

// ===== Pronunciation History (JSON file database) =====
interface PronunciationRecord {
  id: string;
  word: string;
  timestamp: number;
  date: string;           // human-readable
  overall: number;
  pitchStability: number;
  vowelClarity: number;
  voiceQuality: number;
  fluency: number;
  // Comparison scores (if available)
  similarity?: number;
  mfccScore?: number;
  pitchMatch?: number;
  durationRatio?: number;
  f1Similarity?: number;
  f2Similarity?: number;
  intensityMatch?: number;
  // Meta
  category?: string;
  matched: boolean;       // did user speech match the target
}

const HISTORY_FILE = path.join(DATA_DIR, 'pronunciation_history.json');

function loadHistory(): PronunciationRecord[] {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
    }
  } catch (e) {
    console.error('[DB] Failed to load history:', e);
  }
  return [];
}

function saveHistory(records: PronunciationRecord[]): void {
  try {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(records, null, 2), 'utf-8');
  } catch (e) {
    console.error('[DB] Failed to save history:', e);
  }
}

// Save a pronunciation attempt
app.post('/api/pronunciation-history', (req, res) => {
  const { word, scores, comparison, category, matched } = req.body;
  if (!word || !scores) {
    return res.status(400).json({ error: 'word and scores are required' });
  }

  const record: PronunciationRecord = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    word: word.toLowerCase(),
    timestamp: Date.now(),
    date: new Date().toISOString(),
    overall: scores.overall ?? 0,
    pitchStability: scores.pitchStability ?? 0,
    vowelClarity: scores.vowelClarity ?? 0,
    voiceQuality: scores.voiceQuality ?? 0,
    fluency: scores.fluency ?? 0,
    matched: matched ?? true,
    category: category || 'general',
  };

  if (comparison) {
    record.similarity = comparison.overallSimilarity;
    record.mfccScore = comparison.mfccScore;
    record.pitchMatch = comparison.pitchCorrelation;
    record.durationRatio = comparison.durationRatio;
    record.f1Similarity = comparison.f1Similarity;
    record.f2Similarity = comparison.f2Similarity;
    record.intensityMatch = comparison.intensityCorrelation;
  }

  const history = loadHistory();
  history.push(record);
  saveHistory(history);

  console.log(`[DB] 💾 Saved: "${word}" — Overall: ${record.overall}, Similarity: ${record.similarity ?? 'N/A'}`);
  res.json({ status: 'success', record });
});

// Get pronunciation history (optionally filter by word)
app.get('/api/pronunciation-history', (req, res) => {
  const history = loadHistory();
  const word = (req.query.word as string)?.toLowerCase();

  if (word) {
    const filtered = history.filter(r => r.word === word);
    res.json({ status: 'success', records: filtered, total: filtered.length });
  } else {
    res.json({ status: 'success', records: history, total: history.length });
  }
});

// Get summary stats per word
app.get('/api/pronunciation-summary', (req, res) => {
  const history = loadHistory();
  const summary: Record<string, {
    word: string; attempts: number; avgScore: number;
    bestScore: number; lastAttempt: string; trend: number[];
  }> = {};

  for (const r of history) {
    if (!summary[r.word]) {
      summary[r.word] = { word: r.word, attempts: 0, avgScore: 0, bestScore: 0, lastAttempt: '', trend: [] };
    }
    const s = summary[r.word];
    s.attempts++;
    s.avgScore = Math.round(((s.avgScore * (s.attempts - 1)) + r.overall) / s.attempts);
    s.bestScore = Math.max(s.bestScore, r.overall);
    s.lastAttempt = r.date;
    s.trend.push(r.overall);
  }

  res.json({ status: 'success', summary: Object.values(summary) });
});

// ===== Serve comparison audio files =====
// These are the aligned audio segments that Praat actually compared
app.get('/api/audio/ref', (req, res) => {
  const filePath = path.join(process.cwd(), 'debug', 'ref_recording.wav');
  if (fs.existsSync(filePath)) {
    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(filePath);
  } else {
    res.status(404).json({ error: 'Reference audio not available' });
  }
});

app.get('/api/audio/user', (req, res) => {
  const filePath = path.join(process.cwd(), 'debug', 'user_recording.wav');
  if (fs.existsSync(filePath)) {
    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(filePath);
  } else {
    res.status(404).json({ error: 'User audio not available' });
  }
});

// ===== Praat Pronunciation Analysis =====
app.post('/api/analyze-pronunciation', async (req, res) => {
  try {
    const { audioChunks, sampleRate } = req.body;

    if (!audioChunks || !Array.isArray(audioChunks) || audioChunks.length === 0) {
      return res.status(400).json({ error: 'audioChunks (base64 PCM array) is required' });
    }

    const actualRate = sampleRate || 16000;
    console.log(`[PraatService] Analyzing pronunciation: ${audioChunks.length} chunks @ ${actualRate}Hz`);

    const score = await analyzePronunciation(audioChunks, actualRate);

    console.log(`[PraatService] Analysis complete — Overall Score: ${score.overall}`);

    res.json({
      status: 'success',
      score
    });
  } catch (err: any) {
    console.error('[PraatService] Error:', err);
    res.status(500).json({ error: 'Pronunciation analysis failed', details: err.message });
  }
});

// ===== Praat Pronunciation Comparison (with reference) =====
app.post('/api/compare-pronunciation', async (req, res) => {
  try {
    const { refChunks, userChunks, sampleRate, targetWord } = req.body;

    if (!refChunks?.length || !userChunks?.length) {
      return res.status(400).json({ error: 'Both refChunks and userChunks are required' });
    }

    const actualRate = sampleRate || 16000;
    console.log(`[PraatService] Compare request: ref=${refChunks.length} user=${userChunks.length} @ ${actualRate}Hz — word: "${targetWord || ''}"`);

    const comparison = await comparePronunciation(refChunks, userChunks, actualRate, targetWord || '');

    res.json({ status: 'success', comparison });
  } catch (err: any) {
    console.error('[PraatService] Compare error:', err);
    res.status(500).json({ error: 'Comparison failed', details: err.message });
  }
});

// ===== Extract Target Word via DeepSeek-V3 =====
app.post('/api/extract-target-word', async (req, res) => {
  try {
    const { transcript } = req.body;
    if (!transcript || transcript.length < 80) {
      return res.json({ status: 'success', word: null });
    }

    // Strip MASTERED: tags from transcript
    const cleanTranscript = transcript.replace(/MASTERED:\s*\[?\w+\]?/gi, '').trim();

    const prompt = `You are analyzing an English vocabulary teaching session transcript.
Extract the SINGLE vocabulary word that the teacher is CURRENTLY asking the student to practice or repeat.

Rules:
- Return ONLY the target vocabulary word, nothing else.
- Do NOT return common teaching words like "vocabulary", "training", "repeat", "practice", "echo", "listen", "mastered", "master", "session", "analysis", "pronunciation".
- The target word is typically the new/difficult word being taught.
- If the teacher is just introducing themselves or chatting (not teaching a specific word yet), return "NONE".
- IMPORTANT: If multiple words appear in the transcript, return ONLY the LAST/MOST RECENT one.
- If the teacher is giving feedback about pronunciation (e.g. "great job", "try again"), the target word is the one they are giving feedback about.
- NEVER return "mastered".

Transcript:
"${cleanTranscript.substring(0, 500)}"

Target word:`;

    console.log(`[DeepSeek] 📤 Calling DeepSeek-V3 with ${transcript.length} chars...`);

    const response = await fetch('https://api-ai.gitcode.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ZzXhYfx7rvZvMxxHAnzQ8o2s',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'deepseek-ai/DeepSeek-V3',
        messages: [{ role: 'user', content: prompt }],
        stream: false,
        max_tokens: 50,
        temperature: 0.1,
      }),
    });

    const rawText = await response.text();
    let rawWord = '';

    // 🔥 BULLETPROOF PARSER FOR GITCODE CORRUPTED JSON 🔥
    // GitCode API randomly injects invisible carriage returns (\r), spaces, and corrupts the JSON structure.
    // Instead of using JSON.parse (which will throw randomly), we search for the "content":"<word>" pattern directly!
    // We look for any content block that has an actual word

    // First, let's clean any literal carriage returns and strange whitespace
    const cleanedText = rawText.replace(/\r/g, '').replace(/[\x00-\x1F\x7F-\x9F]/g, '');

    // Now extract all text inside "content": "..."
    const matches = [...cleanedText.matchAll(/"content"\s*:\s*"([^"]+)"/g)];

    if (matches.length > 0) {
      // Concatenate all valid content chunks (sometimes it streams despite stream:false)
      rawWord = matches.map(m => m[1]).join('');
    } else {
      console.error(`[DeepSeek] Regex parser failed to find content. Raw snippet: ${rawText.substring(0, 100)}...`);
    }

    const word = rawWord.toLowerCase().replace(/[^a-z-]/g, '');
    console.log(`[DeepSeek] 📥 Raw extracted: "${rawWord}" → Parsed: "${word}"`);

    // Filter out known non-target words
    const blacklist = ['none', 'mastered', 'master', 'repeat', 'practice', 'echo', 'listen', 'vocabulary', 'training', 'session', 'analysis', 'pronunciation'];
    if (word && !blacklist.includes(word) && word.length >= 3) {
      console.log(`[DeepSeek] ✅ Target word: "${word}"`);
      res.json({ status: 'success', word });
    } else {
      console.log(`[DeepSeek] ⏭️ No target word found`);
      res.json({ status: 'success', word: null });
    }
  } catch (err: any) {
    console.error(`[DeepSeek] ❌ API failed:`, err?.message || err);
    res.status(500).json({ status: 'error', error: err?.message || 'DeepSeek API failed' });
  }
});

async function startServer() {
  // Create HTTP server first so Vite HMR WebSocket can attach to it
  const { createServer: createHttpServer } = await import('http');
  const httpServer = createHttpServer(app);

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: { server: httpServer },  // HMR uses the same HTTP server (port 3000)
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(process.cwd(), 'dist')));
    app.get('*', (req, res) => {
      res.sendFile(path.join(process.cwd(), 'dist', 'index.html'));
    });
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`EchoMind Server running on http://localhost:${PORT}`);
  });
}

startServer();
