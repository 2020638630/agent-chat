/**
 * Chat completions against OpenAI-compatible APIs (Ollama / DeepSeek, etc.).
 * When talking to Ollama, always send reasoning_effort: "none"; read message.content only.
 * Content may be a plain string or an OpenAI-style multimodal parts array (text + image_url).
 * Config comes from config/providers (ARCH-2); no local env() copies.
 */
import { getLlmConfig, getVisionConfig, isOllamaTarget } from '../config/providers.js';

export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string | ChatContentPart[];
};

export type ChatCompletionOptions = {
  /** Override model; used for vision turns via LLM_VISION_MODEL. */
  model?: string;
};

/** Vision model for B-04A; empty LLM_VISION_MODEL falls back to LLM_MODEL. */
export function resolveVisionModel(): string {
  return getVisionConfig().model;
}

export async function chatCompletion(
  messages: ChatMessage[],
  opts?: ChatCompletionOptions,
): Promise<string> {
  const cfg = getLlmConfig(opts?.model);

  const body: Record<string, unknown> = {
    model: cfg.model,
    messages,
    temperature: 0.8,
    stream: false,
  };

  // Qwen3.5 / vision via Ollama OpenAI-compat: disable thinking chain when applicable
  if (isOllamaTarget(cfg)) {
    body.reasoning_effort = 'none';
  }

  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
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
