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

    const prompt = `You are analyzing an English vocabulary teaching session transcript.
Extract the SINGLE vocabulary word that the teacher is CURRENTLY asking the student to practice or repeat.

Rules:
- Return ONLY the target vocabulary word, nothing else.
- Do NOT return common teaching words like "vocabulary", "training", "repeat", "practice", "echo", "listen".
- The target word is typically the new/difficult word being taught.
- If the teacher is just introducing themselves or chatting (not teaching a specific word yet), return "NONE".
- IMPORTANT: If multiple words appear in the transcript, return ONLY the LAST/MOST RECENT one. The teacher moves from word to word — always return the newest word being practiced, NOT earlier ones.
- If the teacher is giving feedback about pronunciation (e.g. "great job", "try again"), the target word is the one they are giving feedback about.

Transcript:
"${transcript.substring(0, 500)}"

Target word:`;

    console.log(`[DeepSeek] 📤 Calling DeepSeek-V3 with ${transcript.length} chars of transcript`);

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

    const data = await response.json() as any;
    const rawWord = data?.choices?.[0]?.message?.content?.trim() || '';
    const word = rawWord.toLowerCase().replace(/[^a-z-]/g, '');

    console.log(`[DeepSeek] 📥 Raw: "${rawWord}" → Parsed: "${word}"`);

    if (word && word !== 'none' && word.length >= 3) {
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
