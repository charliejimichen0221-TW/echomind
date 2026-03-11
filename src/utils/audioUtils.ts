/**
 * Audio utilities for EchoMind — handles capture (16kHz) and playback (24kHz).
 *
 * Design:
 * 1. Capture at 16kHz, buffer=4096 (~256ms/chunk) — stable with Praat backend
 * 2. setBuffering(false) while AI speaks → prevents capturing AI playback
 * 3. Scheduling-based playback → zero-gap audio
 * 4. DataView for proper little-endian PCM decoding
 */

// ─────────────────────────────────────────────
// AudioProcessor — microphone capture for Gemini & Praat
// ─────────────────────────────────────────────

export class AudioProcessor {
  private audioContext: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private processor: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private isBuffering = false;
  private isMuted = false;  // When true, stops ALL audio output (to Gemini AND buffer)
  private userBuffer: string[] = [];
  private aiBuffer: string[] = [];
  private peakChunks = 0;
  private onBufferUpdate?: (stats: { chunks: number; memoryKB: number; durationSec: number; peak: number }) => void;

  async startRecording(onChunk: (base64: string) => void) {
    this.audioContext = new AudioContext({ sampleRate: 16000 });
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.source = this.audioContext.createMediaStreamSource(this.stream);
    this.processor = this.audioContext.createScriptProcessor(4096, 1, 1);

    this.source.connect(this.processor);
    this.processor.connect(this.audioContext.destination);

    this.processor.onaudioprocess = (e) => {
      // When muted, skip everything — no audio goes to Gemini or buffer
      if (this.isMuted) return;

      const float32 = e.inputBuffer.getChannelData(0);
      const pcm16 = this.float32ToPCM16(float32);
      const base64 = btoa(String.fromCharCode(...new Uint8Array(pcm16.buffer)));

      onChunk(base64);
      if (this.isBuffering) {
        this.userBuffer.push(base64);
        if (this.userBuffer.length > this.peakChunks) this.peakChunks = this.userBuffer.length;
        // Fire buffer update callback every 10 chunks to avoid spam
        if (this.userBuffer.length % 10 === 0 && this.onBufferUpdate) {
          this.onBufferUpdate(this.getBufferStats());
        }
      }
    };

    console.log(`%c[Audio] 🎙️ Capture ready: ${this.audioContext.sampleRate}Hz`, 'color: #a78bfa');
  }

  stopRecording() {
    this.processor?.disconnect();
    this.source?.disconnect();
    this.stream?.getTracks().forEach(t => t.stop());
    if (this.audioContext?.state !== 'closed') this.audioContext?.close();
  }

  // ── Buffering control ──
  setBuffering(on: boolean) { this.isBuffering = on; }
  getIsBuffering(): boolean { return this.isBuffering; }
  // ── Mute control (stops ALL audio: Gemini + buffer) ──
  setMuted(muted: boolean) { this.isMuted = muted; }
  hasUserAudio(): boolean { return this.userBuffer.length > 0; }
  getUserChunkCount(): number { return this.userBuffer.length; }
  clearUserBuffer() { this.userBuffer = []; }
  flushUserBuffer(): string[] { const b = [...this.userBuffer]; this.userBuffer = []; return b; }

  // ── Buffer stats for debug monitoring ──
  setOnBufferUpdate(cb: (stats: { chunks: number; memoryKB: number; durationSec: number; peak: number }) => void) {
    this.onBufferUpdate = cb;
  }
  getBufferStats() {
    const sampleRate = this.audioContext?.sampleRate ?? 16000;
    return {
      chunks: this.userBuffer.length,
      memoryKB: this.userBuffer.length * 8192 / 1024,
      durationSec: this.userBuffer.length * 4096 / sampleRate,
      peak: this.peakChunks,
    };
  }
  resetPeakChunks() { this.peakChunks = 0; }

  // ── AI reference audio ──
  addAiChunk(base64: string) { this.aiBuffer.push(base64); }
  hasAiAudio(): boolean { return this.aiBuffer.length > 0; }
  getAiChunkCount(): number { return this.aiBuffer.length; }
  clearAiBuffer() { this.aiBuffer = []; }
  flushAiBuffer(): string[] { const b = [...this.aiBuffer]; this.aiBuffer = []; return b; }

  // ── Utilities ──
  getSampleRate(): number { return this.audioContext?.sampleRate ?? 16000; }

  private float32ToPCM16(input: Float32Array): Int16Array {
    const out = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return out;
  }
}

// ─────────────────────────────────────────────
// AudioPlayer — scheduling-based playback at 24kHz
// ─────────────────────────────────────────────

export class AudioPlayer {
  private ctx: AudioContext;
  private nextTime = 0;
  private onVolume?: (v: number) => void;

  constructor(onVolume?: (v: number) => void) {
    this.ctx = new AudioContext({ sampleRate: 24000 });
    this.onVolume = onVolume;
  }

  play(base64: string) {
    const pcm = this.decodePCM16(base64);

    let sum = 0;
    for (let i = 0; i < pcm.length; i++) sum += Math.abs(pcm[i]);
    this.onVolume?.(sum / pcm.length);

    const buf = this.ctx.createBuffer(1, pcm.length, 24000);
    buf.getChannelData(0).set(pcm);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.ctx.destination);

    const now = this.ctx.currentTime;
    if (this.nextTime < now) this.nextTime = now;
    src.start(this.nextTime);
    this.nextTime += buf.duration;

    setTimeout(() => {
      if (this.nextTime <= this.ctx.currentTime + 0.1) this.onVolume?.(0);
    }, buf.duration * 1000 + 150);
  }

  stop() {
    if (this.ctx.state !== 'closed') this.ctx.close();
    this.ctx = new AudioContext({ sampleRate: 24000 });
    this.nextTime = 0;
    this.onVolume?.(0);
  }

  /** Suspend playback (pauses all scheduled audio) */
  async suspend() {
    if (this.ctx.state === 'running') {
      await this.ctx.suspend();
      this.onVolume?.(0);
    }
  }

  /** Resume playback after suspend */
  async resume() {
    if (this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }
  }

  get isPlaying(): boolean {
    return this.ctx.state === 'running' && this.nextTime > this.ctx.currentTime;
  }

  private decodePCM16(base64: string): Float32Array {
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const dv = new DataView(bytes.buffer);
    const out = new Float32Array(dv.byteLength / 2);
    for (let i = 0; i < out.length; i++) out[i] = dv.getInt16(i * 2, true) / 32768.0;
    return out;
  }
}
