# ─── Stage 1: Build the React frontend ─────────────────────────────
FROM node:20-slim AS frontend-builder

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts

COPY . .
# Let Hugging Face inject secrets during build (if available) or pass as ARG
ARG GEMINI_API_KEY
ENV GEMINI_API_KEY=$GEMINI_API_KEY
RUN npm run build

# ─── Stage 2: Production runtime ───────────────────────────────────
FROM python:3.12-slim

# Install Node.js 20, Praat, and system dependencies
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        curl \
        ca-certificates \
        praat \
        libsndfile1 \
        ffmpeg \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ── Python dependencies ──
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# ── Node.js dependencies ──
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --ignore-scripts

# ── Copy application code ──
COPY . .

# ── Copy pre-built frontend from Stage 1 ──
COPY --from=frontend-builder /app/dist ./dist

# ── Create necessary directories ──
RUN mkdir -p data debug

# ── Make start script executable ──
RUN chmod +x start.sh

# HuggingFace Spaces expects port 7860
EXPOSE 7860

# Start both servers
CMD ["./start.sh"]
