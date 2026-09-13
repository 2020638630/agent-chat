export type ChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

function env(name: string, fallback = '') {
  return process.env[name]?.trim() || fallback;
}

function isOllama(baseUrl: string): boolean {
  const provider = env('LLM_PROVIDER').toLowerCase();
  if (provider === 'ollama') return true;
  if (provider && provider !== 'ollama') return false;
  return /11434/.test(baseUrl) || /ollama/i.test(baseUrl);
}

export async function chatCompletion(messages: ChatMessage[]): Promise<string> {
  const baseUrl = env('LLM_BASE_URL', 'http://127.0.0.1:11434/v1').replace(/\/$/, '');
  const apiKey = env('LLM_API_KEY', 'ollama');
  const model = env('LLM_MODEL', 'qwen3.5:9b-nothink');

  const body: Record<string, unknown> = {
    model,
    messages,
    temperature: 0.8,
    stream: false,
  };

  // Qwen3.5 via Ollama OpenAI-compat: disable thinking chain
  if (isOllama(baseUrl)) {
    body.reasoning_effort = 'none';
  }

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`LLM 请求失败 ${res.status}: ${text.slice(0, 500)}`);
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string; reasoning?: string } }>;
  };
  // Use message.content only; never treat message.reasoning as the reply body
  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error('LLM 返回空 content');
  return content;
}