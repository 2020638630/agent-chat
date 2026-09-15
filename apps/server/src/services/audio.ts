/**
 * SiliconFlow STT/TTS helpers + gendered CosyVoice voice selection and cache filenames.
 * Keys come from STT_ and TTS_ env vars; never log secrets.
 */
function env(name: string, fallback = '') {
  return process.env[name]?.trim() || fallback;
}

function requireEnv(name: string): string {
  const v = env(name);
  if (!v) throw new Error(`未配置 ${name}，请在 .env 中填写（勿提交密钥）`);
  return v;
}

export type VoiceKind = 'male' | 'female' | 'user';

const DEFAULT_MALE = 'FunAudioLLM/CosyVoice2-0.5B:alex';
const DEFAULT_FEMALE = 'FunAudioLLM/CosyVoice2-0.5B:anna';
const DEFAULT_USER = 'FunAudioLLM/CosyVoice2-0.5B:david';

/** Known name → gender when card has no gender field. */
const NAME_GENDER: Record<string, VoiceKind> = {
  林深: 'male',
  夜见: 'male',
  小春: 'female',
};

export function voiceForKind(kind: VoiceKind): string {
  if (kind === 'male') {
    return env('TTS_VOICE_MALE', env('TTS_VOICE', DEFAULT_MALE));
  }
  if (kind === 'female') {
    return env('TTS_VOICE_FEMALE', DEFAULT_FEMALE);
  }
  return env('TTS_VOICE_USER', DEFAULT_USER);
}

function digGender(raw: unknown, depth = 0): string | null {
  if (raw == null || depth > 6) return null;
  if (typeof raw === 'string') return null;
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const hit = digGender(item, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  if (typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      if (/^(gender|sex)$/i.test(key)) {
        const v = obj[key];
        if (typeof v === 'string' && v.trim()) return v.trim();
      }
    }
    for (const key of Object.keys(obj)) {
      if (key === 'raw') continue;
      const hit = digGender(obj[key], depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

export function normalizeGenderLabel(label: string | null | undefined): VoiceKind | null {
  if (!label) return null;
  const s = label.trim().toLowerCase();
  if (!s) return null;
  if (/^(m|male|man|boy|男|男性|公)$/i.test(s) || s.includes('男')) return 'male';
  if (/^(f|female|woman|girl|女|女性|母)$/i.test(s) || s.includes('女')) return 'female';
  return null;
}

export function resolveCharacterVoiceKind(name: string, rawJson?: string | null): VoiceKind {
  let raw: unknown = null;
  if (rawJson) {
    try {
      raw = JSON.parse(rawJson);
    } catch {
      raw = null;
    }
  }
  const fromCard = normalizeGenderLabel(digGender(raw));
  if (fromCard === 'male' || fromCard === 'female') return fromCard;

  const n = (name || '').trim();
  if (NAME_GENDER[n]) return NAME_GENDER[n];
  // partial match for names like 「林深·xxx」
  for (const [k, g] of Object.entries(NAME_GENDER)) {
    if (n.includes(k)) return g;
  }
  return 'female';
}

/** Strip *actions*, markdown, and excess whitespace before TTS. */
export function stripForTts(text: string): string {
  let s = text || '';
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

export async function synthesizeSpeech(text: string, voice?: string): Promise<Buffer> {
  const baseUrl = env('TTS_BASE_URL', 'https://api.siliconflow.cn/v1').replace(/\/$/, '');
  const apiKey = requireEnv('TTS_API_KEY');
  const model = env('TTS_MODEL', 'FunAudioLLM/CosyVoice2-0.5B');
  const useVoice = (voice || voiceForKind('female')).trim();
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
      voice: useVoice,
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

export function voiceCacheSlug(voice: string): string {
  return voice.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80) || 'default';
}

/** Cache key includes voice so remapping gender never replays the wrong timbre. */
export function ttsFilename(messageId: string, voice: string): string {
  return `tts-${messageId}-${voiceCacheSlug(voice)}.mp3`;
}

export function isTtsCacheFileForMessage(filename: string, messageId: string): boolean {
  return (
    filename === `tts-${messageId}.mp3` ||
    (filename.startsWith(`tts-${messageId}-`) && filename.endsWith('.mp3'))
  );
}
