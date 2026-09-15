/**
 * B-07: detect whether this user turn is asking the character to speak/sing aloud.
 * Keyword/phrase match only — no LLM classification.
 */

/** Phrases that mean "please reply with voice / sing". Keep short request forms. */
export const VOICE_REQUEST_PHRASES = [
  // sing
  '唱首歌',
  '唱一首',
  '唱个歌',
  '唱个',
  '唱歌',
  '唱一首歌',
  '来首歌',
  '来一句歌',
  '哼一首',
  '哼一句',
  // speak aloud
  '说句话',
  '说一句',
  '说句话我听听',
  '说一句我听听',
  '说给我听',
  // hear voice
  '听听你的声音',
  '听一下你的声音',
  '让我听听',
  '让我听听你的声音',
  '用语音',
  '语音回复',
  '发条语音',
  '发个语音',
  '回条语音',
  '回个语音',
  '语音说',
  '用声音回复',
] as const;

/** Compliments / evaluations that may contain 唱歌 but are NOT a request to perform. */
const EVALUATION_RE =
  /真好听|好听极|唱得真|唱的真|唱得真好|唱的真好|真不错|太好听|好喜欢你唱|喜欢听你唱/;

function normalizeForMatch(text: string): string {
  return (text || '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[\u200b\u00a0]/g, '')
    // strip common CJK/EN punctuation
    .replace(/[，。！？、；：…—～·""''「」『』（）【】\[\](){}<>《》,.!?;:'"`~\-_/\\|]/g, '');
}

/**
 * True when the current user utterance is requesting an audible reply
 * (sing / speak / send a voice message), not merely commenting on singing.
 */
export function wantsVoiceReply(userText: string): boolean {
  const n = normalizeForMatch(userText);
  if (!n) return false;
  if (EVALUATION_RE.test(n)) return false;

  for (const phrase of VOICE_REQUEST_PHRASES) {
    const p = normalizeForMatch(phrase);
    if (p && n.includes(p)) return true;
  }
  return false;
}

/** Assistant message should be a voice bubble for this turn. */
export function shouldAssistantUseVoice(
  userSource: 'text' | 'voice',
  userText: string
): boolean {
  if (userSource === 'voice') return true;
  return wantsVoiceReply(userText);
}
