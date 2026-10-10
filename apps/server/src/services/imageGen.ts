/**
 * OpenAI-compatible image generation (SiliconFlow by default).
 * Config via config/providers (IMAGE_GEN_*); never log API keys.
 */
import { saveImageBuffer } from './uploadImage.js';
import { getImageGenConfig } from '../config/providers.js';

const DEFAULT_IMAGE_STYLE =
  'anime illustration, clean lines, soft lighting, character-consistent portrait, tasteful, no watermark, no text';

export function wantsImageGeneration(text: string): boolean {
  const t = String(text || '').trim();
  if (!t) return false;
  return /画一[张个幅]|画个|画张|帮我画|给我画|生成一[张个]图|生成图片|来一[张个]图|出一[张个]图|画张图|draw (me )?(a|an)|generate (an? )?image/i.test(
    t,
  );
}

/** Short prompt from user text; rule template, no second agent. */
export function buildImagePrompt(userText: string, characterName: string): string {
  let subject = String(userText || '').trim();
  subject = subject
    .replace(/^(请|麻烦|帮我|给我)?(画一[张个幅]|画个|画张|生成一[张个]图|生成图片|来一[张个]图|出一[张个]图)/, '')
    .replace(/^(please\s+)?(draw|generate)\s+(me\s+)?(a|an)?\s*/i, '')
    .trim();
  if (!subject) subject = userText.trim();
  return (
    
    `Character-aware illustration for chat bubble. Soft lighting, clean composition, no watermark, no UI chrome. ` +
    `Drawn in a style that fits persona "${characterName}". Subject: ${subject}`
   +
    `. ${DEFAULT_IMAGE_STYLE}`
  );
}

export type GeneratedImage = {
  publicPath: string;
  model: string;
};

export async function generateChatImage(prompt: string): Promise<GeneratedImage> {
  const cfg = getImageGenConfig();

  const res = await fetch(`${cfg.baseUrl}/images/generations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      prompt,
      image_size: '1024x1024',
      batch_size: 1,
    }),
    signal: AbortSignal.timeout(180_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`生图失败 ${res.status}: ${text.slice(0, 400)}`);
  }

  const data = (await res.json()) as {
    images?: Array<{ url?: string; b64_json?: string }>;
    data?: Array<{ url?: string; b64_json?: string }>;
  };
  const item = data.images?.[0] || data.data?.[0];
  if (!item) throw new Error('生图返回为空');

  let buffer: Buffer;
  let ext = '.png';
  if (item.b64_json) {
    buffer = Buffer.from(item.b64_json, 'base64');
  } else if (item.url) {
    if (item.url.startsWith('data:')) {
      const m = item.url.match(/^data:(image\/[\w+.-]+);base64,(.+)$/);
      if (!m) throw new Error('无法解析 data URL 图片');
      if (m[1].includes('jpeg') || m[1].includes('jpg')) ext = '.jpg';
      else if (m[1].includes('webp')) ext = '.webp';
      buffer = Buffer.from(m[2], 'base64');
    } else {
      const imgRes = await fetch(item.url, { signal: AbortSignal.timeout(120_000) });
      if (!imgRes.ok) throw new Error(`下载生图失败 ${imgRes.status}`);
      const ctype = imgRes.headers.get('content-type') || '';
      if (ctype.includes('jpeg') || ctype.includes('jpg')) ext = '.jpg';
      else if (ctype.includes('webp')) ext = '.webp';
      buffer = Buffer.from(await imgRes.arrayBuffer());
    }
  } else {
    throw new Error('生图结果无 url / b64_json');
  }

  const saved = saveImageBuffer(buffer, ext, 'gen-img');
  return { publicPath: saved.publicPath, model: cfg.model };
}
