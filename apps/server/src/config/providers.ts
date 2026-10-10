/**
 * ARCH-2 provider config layer (pipe, not scheduler).
 * Business code reads llm/vision/stt/tts/imageGen settings here, then calls
 * existing OpenAI-compatible HTTP helpers. No runtime multi-vendor routing (N-02).
 */
import { env, requireEnv } from './env.js';

export type ProviderKind = 'llm' | 'vision' | 'stt' | 'tts' | 'imageGen';

export type ProviderConfig = {
  kind: ProviderKind;
  /** OpenAI-compatible base URL without trailing slash */
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Optional vendor hint for LLM (ollama / deepseek / …) */
  provider?: string;
};

export type TtsProviderConfig = ProviderConfig & {
  voiceDefault: string;
  voiceMale: string;
  voiceFemale: string;
  voiceUser: string;
};

const DEFAULT_LLM_BASE = 'http://127.0.0.1:11434/v1';
const DEFAULT_LLM_MODEL = 'qwen3.5:9b-nothink';
const DEFAULT_SILICON_BASE = 'https://api.siliconflow.cn/v1';
const DEFAULT_STT_MODEL = 'FunAudioLLM/SenseVoiceSmall';
const DEFAULT_TTS_MODEL = 'FunAudioLLM/CosyVoice2-0.5B';
const DEFAULT_TTS_VOICE = 'FunAudioLLM/CosyVoice2-0.5B:alex';
const DEFAULT_TTS_VOICE_FEMALE = 'FunAudioLLM/CosyVoice2-0.5B:anna';
const DEFAULT_TTS_VOICE_USER = 'FunAudioLLM/CosyVoice2-0.5B:david';
const DEFAULT_IMAGE_MODEL = 'Kwai-Kolors/Kolors';

let imageGenFallbackWarned = false;

function stripSlash(url: string): string {
  return url.replace(/\/$/, '');
}

/** LLM chat completions (text). */
export function getLlmConfig(modelOverride?: string): ProviderConfig {
  const baseUrl = stripSlash(env('LLM_BASE_URL', DEFAULT_LLM_BASE));
  const apiKey = env('LLM_API_KEY', 'ollama');
  const model = (modelOverride?.trim() || env('LLM_MODEL', DEFAULT_LLM_MODEL));
  return {
    kind: 'llm',
    baseUrl,
    apiKey,
    model,
    provider: env('LLM_PROVIDER').toLowerCase() || undefined,
  };
}

/**
 * Vision / read-image model. Same baseUrl/apiKey as LLM;
 * model = LLM_VISION_MODEL or fall back to LLM_MODEL.
 */
export function getVisionConfig(): ProviderConfig {
  const base = getLlmConfig();
  const visionModel = env('LLM_VISION_MODEL') || base.model;
  return {
    kind: 'vision',
    baseUrl: base.baseUrl,
    apiKey: base.apiKey,
    model: visionModel,
    provider: base.provider,
  };
}

export function getSttConfig(): ProviderConfig {
  return {
    kind: 'stt',
    baseUrl: stripSlash(env('STT_BASE_URL', DEFAULT_SILICON_BASE)),
    apiKey: requireEnv('STT_API_KEY'),
    model: env('STT_MODEL', DEFAULT_STT_MODEL),
  };
}

/** Voice ids only — safe to call without TTS_API_KEY (e.g. cache slug). */
export function getTtsVoiceSettings(): Pick<
  TtsProviderConfig,
  'voiceDefault' | 'voiceMale' | 'voiceFemale' | 'voiceUser'
> {
  const voiceDefault = env('TTS_VOICE', DEFAULT_TTS_VOICE);
  return {
    voiceDefault,
    voiceMale: env('TTS_VOICE_MALE', voiceDefault || DEFAULT_TTS_VOICE),
    voiceFemale: env('TTS_VOICE_FEMALE', DEFAULT_TTS_VOICE_FEMALE),
    voiceUser: env('TTS_VOICE_USER', DEFAULT_TTS_VOICE_USER),
  };
}

export function getTtsConfig(): TtsProviderConfig {
  const voices = getTtsVoiceSettings();
  return {
    kind: 'tts',
    baseUrl: stripSlash(env('TTS_BASE_URL', DEFAULT_SILICON_BASE)),
    apiKey: requireEnv('TTS_API_KEY'),
    model: env('TTS_MODEL', DEFAULT_TTS_MODEL),
    ...voices,
  };
}

/**
 * Image generation. Prefer explicit IMAGE_GEN_API_KEY (D-09).
 * Compat: if empty, may fall back to STT_API_KEY with a one-shot warning;
 * treat as temporary — set IMAGE_GEN_API_KEY to silence and lock the key.
 */
export function getImageGenConfig(): ProviderConfig {
  const baseUrl = stripSlash(env('IMAGE_GEN_BASE_URL', DEFAULT_SILICON_BASE));
  const explicit = env('IMAGE_GEN_API_KEY');
  const sttFallback = env('STT_API_KEY');
  let apiKey = explicit;
  if (!apiKey && sttFallback) {
    apiKey = sttFallback;
    if (!imageGenFallbackWarned) {
      imageGenFallbackWarned = true;
      console.warn(
        '[providers] IMAGE_GEN_API_KEY unset; falling back to STT_API_KEY (compat period). ' +
          'Set IMAGE_GEN_API_KEY explicitly; this fallback may be removed later.',
      );
    }
  }
  if (!apiKey) {
    throw new Error('未配置 IMAGE_GEN_API_KEY，请在本机 .env 填写（勿再用 STT_API_KEY 冒充；兼容回落仅过渡）');
  }
  return {
    kind: 'imageGen',
    baseUrl,
    apiKey,
    model: env('IMAGE_GEN_MODEL', DEFAULT_IMAGE_MODEL),
  };
}

/** True when LLM target is Ollama (provider flag or URL heuristic). */
export function isOllamaTarget(cfg: ProviderConfig): boolean {
  const provider = (cfg.provider || '').toLowerCase();
  if (provider === 'ollama') return true;
  if (provider && provider !== 'ollama') return false;
  return /11434/.test(cfg.baseUrl) || /ollama/i.test(cfg.baseUrl);
}
