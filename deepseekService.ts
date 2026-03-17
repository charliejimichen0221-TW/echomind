/**
 * DeepSeek Chat Service
 * =====================
 * Provides LLM chat completion using DeepSeek API (OpenAI-compatible).
 * Supports streaming responses for real-time feedback.
 */
import OpenAI from 'openai';

const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!client) {
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) {
      throw new Error('DEEPSEEK_API_KEY environment variable is required');
    }
    client = new OpenAI({
      baseURL: DEEPSEEK_BASE_URL,
      apiKey,
    });
  }
  return client;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * Send a chat completion request to DeepSeek.
 * Returns the full response text.
 */
export async function chatCompletion(
  messages: ChatMessage[],
  options?: {
    model?: string;
    temperature?: number;
    maxTokens?: number;
  }
): Promise<string> {
  const ai = getClient();
  const model = options?.model || 'deepseek-chat';
  
  console.log(`[DeepSeek] Sending ${messages.length} messages to ${model}...`);
  
  const response = await ai.chat.completions.create({
    model,
    messages,
    temperature: options?.temperature ?? 0.7,
    max_tokens: options?.maxTokens ?? 512,
  });

  const text = response.choices[0]?.message?.content || '';
  console.log(`[DeepSeek] Response: "${text.substring(0, 80)}..." (${text.length} chars)`);
  return text;
}

/**
 * Send a streaming chat completion request to DeepSeek.
 * Calls onChunk for each text chunk received.
 * Returns the full accumulated text.
 */
export async function chatCompletionStream(
  messages: ChatMessage[],
  onChunk: (chunk: string) => void,
  options?: {
    model?: string;
    temperature?: number;
    maxTokens?: number;
  }
): Promise<string> {
  const ai = getClient();
  const model = options?.model || 'deepseek-chat';
  
  console.log(`[DeepSeek] Streaming ${messages.length} messages to ${model}...`);
  
  const stream = await ai.chat.completions.create({
    model,
    messages,
    temperature: options?.temperature ?? 0.7,
    max_tokens: options?.maxTokens ?? 512,
    stream: true,
  });

  let fullText = '';
  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content || '';
    if (delta) {
      fullText += delta;
      onChunk(delta);
    }
  }
  
  console.log(`[DeepSeek] Stream complete: "${fullText.substring(0, 80)}..." (${fullText.length} chars)`);
  return fullText;
}
