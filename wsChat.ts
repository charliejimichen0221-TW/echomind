/**
 * WebSocket Chat Handler
 * =======================
 * Manages real-time voice conversation sessions between the browser and
 * DeepSeek + Edge TTS backend. Replaces the Gemini Live API.
 *
 * Flow:
 *   1. Client sends `start` → server initializes session
 *   2. Client sends `audio` chunks → server buffers them
 *   3. Client sends `user_stopped` → server runs STT → DeepSeek → TTS → sends audio back
 *   4. Client sends `end` → server cleans up
 */
import { WebSocketServer, WebSocket } from 'ws';
import { Server } from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { chatCompletion, ChatMessage } from './deepseekService.js';

const SPEECH_SERVER_URL = 'http://127.0.0.1:5051';

interface Session {
  ws: WebSocket;
  messages: ChatMessage[];
  audioChunks: string[];    // base64 PCM chunks from user
  sampleRate: number;
  isProcessing: boolean;
  systemInstruction: string;
}

const sessions = new Map<WebSocket, Session>();

// ─── Helper: HTTP requests to speech server ────────────────────────
async function httpPost(url: string, body: any): Promise<any> {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return resp.json();
}

// ─── Helper: Save PCM chunks to WAV file ───────────────────────────
function saveChunksToWav(chunks: string[], sampleRate: number): string {
  const buffers = chunks.map(c => Buffer.from(c, 'base64'));
  const totalLength = buffers.reduce((sum, b) => sum + b.length, 0);
  const pcmData = Buffer.concat(buffers, totalLength);

  // Create WAV header (16-bit mono PCM)
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcmData.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);      // chunk size
  header.writeUInt16LE(1, 20);       // PCM format
  header.writeUInt16LE(1, 22);       // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);  // byte rate
  header.writeUInt16LE(2, 32);       // block align
  header.writeUInt16LE(16, 34);      // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(pcmData.length, 40);

  const wavBuffer = Buffer.concat([header, pcmData]);
  const tmpPath = path.join(os.tmpdir(), `echomind_stt_${Date.now()}.wav`);
  fs.writeFileSync(tmpPath, wavBuffer);
  return tmpPath;
}

// ─── Helper: Read WAV and convert to base64 PCM chunks ─────────────
function wavToBase64Chunks(wavPath: string, chunkSize: number = 4800): string[] {
  const data = fs.readFileSync(wavPath);
  // Skip WAV header (44 bytes)
  const pcm = data.subarray(44);
  const chunks: string[] = [];
  for (let i = 0; i < pcm.length; i += chunkSize * 2) { // *2 for 16-bit
    const chunk = pcm.subarray(i, Math.min(i + chunkSize * 2, pcm.length));
    chunks.push(chunk.toString('base64'));
  }
  return chunks;
}

// ─── Send JSON message to client safely ────────────────────────────
function sendToClient(ws: WebSocket, msg: object) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

// ─── Process user speech: STT → DeepSeek → TTS → send audio ───────
async function processUserSpeech(session: Session) {
  if (session.audioChunks.length === 0) return;
  if (session.isProcessing) return;

  session.isProcessing = true;
  const ws = session.ws;

  try {
    // 1. Save audio chunks to WAV
    const wavPath = saveChunksToWav(session.audioChunks, session.sampleRate);
    session.audioChunks = []; // Clear buffer

    // 2. STT: Transcribe user speech
    console.log(`[WSChat] Running STT...`);
    const sttResult = await httpPost(`${SPEECH_SERVER_URL}/stt`, { wav_path: wavPath });

    // Clean up temp file
    try { fs.unlinkSync(wavPath); } catch {}

    if (!sttResult.text || sttResult.text.trim().length === 0) {
      console.log(`[WSChat] STT returned empty text, ignoring.`);
      session.isProcessing = false;
      return;
    }

    const userText = sttResult.text.trim();
    console.log(`[WSChat] User said: "${userText}"`);

    // Send user transcript to frontend
    sendToClient(ws, { type: 'user_transcript', text: userText });

    // 3. Add user message to conversation history
    session.messages.push({ role: 'user', content: userText });

    // 4. DeepSeek: Get AI response
    console.log(`[WSChat] Calling DeepSeek...`);
    const aiText = await chatCompletion(session.messages, {
      temperature: 0.7,
      maxTokens: 512,
    });

    if (!aiText) {
      session.isProcessing = false;
      return;
    }

    // Add AI response to conversation history
    session.messages.push({ role: 'assistant', content: aiText });

    // Send AI transcript to frontend
    sendToClient(ws, { type: 'ai_transcript', text: aiText });

    // 5. TTS: Convert AI response to speech
    console.log(`[WSChat] Running TTS...`);
    sendToClient(ws, { type: 'turn_start' });

    const ttsResult = await httpPost(`${SPEECH_SERVER_URL}/tts`, {
      text: aiText,
      voice: 'en-US-AriaNeural',
      rate: '-5%', // Slightly slower for learners
    });

    if (ttsResult.error) {
      console.error(`[WSChat] TTS error: ${ttsResult.error}`);
      sendToClient(ws, { type: 'turn_end' });
      session.isProcessing = false;
      return;
    }

    // 6. Send audio chunks to frontend
    const audioChunks = wavToBase64Chunks(ttsResult.wav_path);
    console.log(`[WSChat] Sending ${audioChunks.length} audio chunks to client...`);

    for (const chunk of audioChunks) {
      sendToClient(ws, {
        type: 'ai_audio',
        data: chunk,
        sampleRate: ttsResult.sample_rate || 24000,
      });
    }

    sendToClient(ws, { type: 'turn_end' });

    // Clean up TTS temp file
    try { fs.unlinkSync(ttsResult.wav_path); } catch {}

    console.log(`[WSChat] Turn complete.`);
  } catch (err: any) {
    console.error(`[WSChat] Error processing speech:`, err.message);
    sendToClient(ws, { type: 'error', message: err.message });
  }

  session.isProcessing = false;
}

// ─── Setup WebSocket Server ────────────────────────────────────────
export function setupWebSocketChat(server: Server) {
  const wss = new WebSocketServer({ server, path: '/ws/chat' });

  console.log(`[WSChat] WebSocket chat server ready on /ws/chat`);

  wss.on('connection', (ws) => {
    console.log(`[WSChat] New connection`);

    ws.on('message', async (raw) => {
      try {
        const msg = JSON.parse(raw.toString());

        switch (msg.type) {
          case 'start': {
            // Initialize a new session
            const session: Session = {
              ws,
              messages: [
                { role: 'system', content: msg.systemInstruction || 'You are Echo, an English vocabulary coach.' },
              ],
              audioChunks: [],
              sampleRate: msg.sampleRate || 16000,
              isProcessing: false,
              systemInstruction: msg.systemInstruction || '',
            };
            sessions.set(ws, session);
            console.log(`[WSChat] Session started`);
            sendToClient(ws, { type: 'ready' });

            // Auto-start: AI introduces itself
            console.log(`[WSChat] AI intro...`);
            session.messages.push({ role: 'user', content: '[Session started. Please introduce yourself and the first word.]' });
            await processUserSpeech_textOnly(session);
            break;
          }

          case 'audio': {
            // Buffer audio chunk
            const session = sessions.get(ws);
            if (session && !session.isProcessing) {
              session.audioChunks.push(msg.data);
            }
            break;
          }

          case 'user_stopped': {
            // User stopped speaking, process the buffered audio
            const session = sessions.get(ws);
            if (session) {
              await processUserSpeech(session);
            }
            break;
          }

          case 'end': {
            sessions.delete(ws);
            console.log(`[WSChat] Session ended`);
            break;
          }
        }
      } catch (err: any) {
        console.error(`[WSChat] Message error:`, err.message);
      }
    });

    ws.on('close', () => {
      sessions.delete(ws);
      console.log(`[WSChat] Connection closed`);
    });
  });
}

// ─── Text-only processing (for AI auto-intro) ──────────────────────
async function processUserSpeech_textOnly(session: Session) {
  session.isProcessing = true;
  const ws = session.ws;

  try {
    const aiText = await chatCompletion(session.messages, {
      temperature: 0.7,
      maxTokens: 512,
    });

    if (!aiText) {
      session.isProcessing = false;
      return;
    }

    // Replace the fake user message with assistant response
    session.messages.pop(); // Remove '[Session started...]'
    session.messages.push({ role: 'assistant', content: aiText });

    sendToClient(ws, { type: 'ai_transcript', text: aiText });
    sendToClient(ws, { type: 'turn_start' });

    const ttsResult = await httpPost(`${SPEECH_SERVER_URL}/tts`, {
      text: aiText,
      voice: 'en-US-AriaNeural',
      rate: '-5%',
    });

    if (!ttsResult.error) {
      const audioChunks = wavToBase64Chunks(ttsResult.wav_path);
      for (const chunk of audioChunks) {
        sendToClient(ws, {
          type: 'ai_audio',
          data: chunk,
          sampleRate: ttsResult.sample_rate || 24000,
        });
      }
      try { fs.unlinkSync(ttsResult.wav_path); } catch {}
    }

    sendToClient(ws, { type: 'turn_end' });
  } catch (err: any) {
    console.error(`[WSChat] Auto-intro error:`, err.message);
  }

  session.isProcessing = false;
}
