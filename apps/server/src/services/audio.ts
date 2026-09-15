function env(name: string, fallback = '') {
  return process.env[name]?.trim() || fallback;
}

function requireEnv(name: string): string {
  const v = env(name);
  if (!v) throw new Error(`未配置 ${name}，请在 .env 中填写（勿提交密钥）`);
  return v;
}

/** Strip *actions*, markdown, and excess whitespace before TTS. */
export function stripForTts(text: string): string {
  let s = text || '';
  // *action* / （动作） / (action)
  s = s.replace(/\*[^*\n]{1,80}\*/g, ' ');
  s = s.replace(/（[^）]{0,40}）/g, (m) => (/动作|旁白|系统|LLM/.test(m) ? ' ' : m));
  s = s.replace(/\([^)]{0,40}\)/g, (m) => (/LLM|系统/.test(m) ? ' ' : m));
  s = s.replace(/[#>*_`~]/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

export async function transcribeAudio(
  buffer: Buffer,
  filename: string,
  mimeType: string
): Promise<string> {
  const baseUrl = env('STT_BASE_URL', 'https://api.siliconflow.cn/v1').replace(/\/$/, '');
  const apiKey = requireEnv('STT_API_KEY');
  const model = env('STT_MODEL', 'FunAudioLLM/SenseVoiceSmall');

  const form = new FormData();
  const blob = new Blob([new Uint8Array(buffer)], { type: mimeType || 'audio/wav' });
  form.append('file', blob, filename || 'audio.wav');
  form.append('model', model);

  const res = await fetch(`${baseUrl}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal: AbortSignal.timeout(120_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`语音识别失败 ${res.status}: ${text.slice(0, 300)}`);
  }

  const data = (await res.json()) as { text?: string };
  const text = (data.text || '').trim();
  if (!text) throw new Error('未能识别出有效文字，请再说一遍');
  return text;
}

export async function synthesizeSpeech(text: string): Promise<Buffer> {
  const baseUrl = env('TTS_BASE_URL', 'https://api.siliconflow.cn/v1').replace(/\/$/, '');
  const apiKey = requireEnv('TTS_API_KEY');
  const model = env('TTS_MODEL', 'FunAudioLLM/CosyVoice2-0.5B');
  const voice = env('TTS_VOICE', 'FunAudioLLM/CosyVoice2-0.5B:alex');
  const input = stripForTts(text);
  if (!input) throw new Error('没有可朗读的文字');

  const res = await fetch(`${baseUrl}/audio/speech`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      input,
      voice,
      response_format: 'mp3',
    }),
    signal: AbortSignal.timeout(120_000),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`语音合成失败 ${res.status}: ${errText.slice(0, 300)}`);
  }

  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

export function ttsFilename(messageId: string): string {
  return `tts-${messageId}.mp3`;
}
