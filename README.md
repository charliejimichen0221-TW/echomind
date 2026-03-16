---
title: Echomind
emoji: 🎤
colorFrom: purple
colorTo: blue
sdk: docker
pinned: false
app_port: 7860
license: mit
---

<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# EchoMind — AI-Powered Pronunciation Coach

An intelligent pronunciation learning system powered by **Google Gemini Live API** that provides real-time, scientifically-grounded feedback on English pronunciation.

## Features

- 🎙️ **Real-time Conversation** with AI tutor via Gemini Live API
- 📊 **F1/F2 Formant Analysis** using Praat for precise vowel measurement
- 🧠 **MMS Forced Alignment** for per-syllable phoneme-level feedback  
- 🔊 **MFCC-DTW Comparison** between user and reference pronunciation
- 🔤 **wav2vec2 Phoneme Recognition** for pronunciation accuracy scoring
- ☁️ **Firebase Realtime Database** for cloud-based progress tracking

## Tech Stack

- **AI**: Google Gemini 2.0 Flash (Live API) via `@google/genai` SDK
- **Frontend**: React + TypeScript + Vite
- **Backend**: Node.js (Express) + Python (PyTorch)
- **Analysis**: Praat, librosa, torchaudio
- **Cloud**: Firebase Realtime Database (Google Cloud)

## Run Locally

**Prerequisites:** Node.js 20+, Python 3.12+

1. Install dependencies:
   ```bash
   npm install
   pip install -r requirements.txt
   ```
2. Set `GEMINI_API_KEY` in `.env.local`
3. Run: `npm run dev`
