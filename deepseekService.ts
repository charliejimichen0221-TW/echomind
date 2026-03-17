/**
 * DeepSeek Chat Service (via GitCode)
 * ====================================
 * Uses raw fetch to handle GitCode's always-streaming API format.
 */

const LLM_BASE_URL = process.env.LLM_BASE_URL || 'https://api-ai.gitcode.com/v1';
const LLM_MODEL = process.env.LLM_MODEL || 'deepseek-v3.1';

function getApiKey(): string {
  const key = process.env.LLM_API_KEY || process.env.DEEPSEEK_API_KEY;
  if (!key) throw new Error('LLM_API_KEY or DEEPSEEK_API_KEY environment variable is required');
  return key;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * Parse SSE streaming response from GitCode's DeepSeek API.
 * Collects all text chunks and returns the full response.
 */
async function parseSSEResponse(response: Response): Promise<string> {
  const text = await response.text();
  let fullContent = '';
  
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    
    const jsonStr = trimmed.slice(5).trim();
    if (jsonStr === '[DONE]') break;
    
    try {
      const parsed = JSON.parse(jsonStr);
      const delta = parsed.choices?.[0]?.delta?.content || '';
      if (delta) fullContent += delta;
    } catch {}
  }
  
  return fullContent;
}

/**
 * Send a chat completion request to DeepSeek via GitCode.
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
  const model = options?.model || LLM_MODEL;
  const apiKey = getApiKey();
  
  console.log(`[LLM] Sending ${messages.length} messages to ${model} via ${LLM_BASE_URL}...`);
  
  const response = await fetch(`${LLM_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: options?.temperature ?? 0.7,
      max_tokens: options?.maxTokens ?? 512,
      stream: true,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`LLM API error (${response.status}): ${errText.substring(0, 200)}`);
  }

  const fullText = await parseSSEResponse(response);
  console.log(`[LLM] Response: "${fullText.substring(0, 80)}..." (${fullText.length} chars)`);
  return fullText;
}

/**
 * Send a streaming chat completion request.
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
  const model = options?.model || LLM_MODEL;
  const apiKey = getApiKey();
  
  console.log(`[LLM] Streaming ${messages.length} messages to ${model}...`);
  
  const response = await fetch(`${LLM_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: options?.temperature ?? 0.7,
      max_tokens: options?.maxTokens ?? 512,
      stream: true,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`LLM API error (${response.status}): ${errText.substring(0, 200)}`);
  }

  // Parse streaming response line by line
  const text = await response.text();
  let fullText = '';
  
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const jsonStr = trimmed.slice(5).trim();
    if (jsonStr === '[DONE]') break;
    
    try {
      const parsed = JSON.parse(jsonStr);
      const delta = parsed.choices?.[0]?.delta?.content || '';
      if (delta) {
        fullText += delta;
        onChunk(delta);
      }
    } catch {}
  }
  
  console.log(`[LLM] Stream complete: "${fullText.substring(0, 80)}..." (${fullText.length} chars)`);
  return fullText;
}
