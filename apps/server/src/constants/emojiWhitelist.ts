/**
 * C-04 白名单；前后端须保持一致
 * Keep in sync with apps/web/src/constants/emojiWhitelist.ts
 */
export const EMOJI_WHITELIST: string[] = [
  "🙂", "😊", "😄", "😁", "😆", "😅", "😂", "🤣", "😉", "😌",
  "😍", "🥰", "😘", "😜", "🤪", "🤔", "🤨", "😐", "😑", "😶",
  "🙄", "😏", "😮", "😯", "😲", "😳", "🥺", "😢", "😭", "😤",
  "😠", "😡", "🤯", "😱", "😨", "😰", "😓", "🤗", "🤭", "🤫",
  "😴", "😪", "😵", "🥴", "😷", "😎", "🤓", "🥳", "😕", "😟",
  "🙁", "😣", "😖", "😫", "😩", "😬", "🤐", "❤️", "💕", "💔",
  "👍", "👎", "👏", "🙏", "✌️", "🤝", "💪", "✨", "🔥", "⭐",
  "🎉", "💯", "💢", "💦", "💤", "💡", "📌", "✅", "❌", "👀",
  "💀", "👻",
];

export const EMOJI_WHITELIST_SET: Set<string> = new Set(EMOJI_WHITELIST);

/** Compact block injected into existing chat system prompts (private + group). */
export function emojiConstraintForPrompt(): string {
  const list = EMOJI_WHITELIST.join('');
  return `【表情符号·硬规则】默认输出纯文字，不要带任何表情。
仅当本轮情绪非常明显（大笑/安慰/生气/害羞等）或用户本轮自己用了表情时，才允许在句末最多加 1 个白名单表情；白名单：${list}
禁止：每句都加、句首堆表情、一条超过 1 个、白名单外符号。冷静/克制/冷淡人设（如夜见）一律不加表情。`;
}

/** Extended pictographic (+ optional VS16) and simple ZWJ sequences. */
const EMOJI_TOKEN_RE =
  /\p{Extended_Pictographic}(?:\uFE0F)?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F)?)*/gu;

export function hasEmojiToken(text: string): boolean {
  if (!text) return false;
  EMOJI_TOKEN_RE.lastIndex = 0;
  return EMOJI_TOKEN_RE.test(text);
}

/**
 * Post-process assistant reply before DB insert (never call on user messages).
 * - Drop non-whitelist emoji
 * - Keep at most 1 whitelist emoji (leftmost)
 * - If recentHadEmoji (caller: last 2 assistant msgs), strip all emoji
 * - Never leave an emoji-only / empty body
 */
export function sanitizeAssistantEmoji(
  content: string,
  opts: { recentAssistantHadEmoji: boolean },
): string {
  const raw = typeof content === 'string' ? content : '';
  if (!raw) return raw;

  const stripAll = (s: string) => {
    EMOJI_TOKEN_RE.lastIndex = 0;
    return s.replace(EMOJI_TOKEN_RE, '').replace(/\uFE0F/g, '').replace(/[ \t]{2,}/g, ' ').trim();
  };

  const keepAtMostOneWhitelist = (s: string) => {
    let kept = false;
    EMOJI_TOKEN_RE.lastIndex = 0;
    return s.replace(EMOJI_TOKEN_RE, (tok) => {
      const normalized = tok.replace(/\uFE0E/g, '');
      // try exact token and token without VS
      const candidates = [tok, normalized, tok.replace(/\uFE0F/g, ''), normalized + '\uFE0F'];
      const ok = candidates.some((c) => EMOJI_WHITELIST_SET.has(c)) || EMOJI_WHITELIST_SET.has(tok);
      // also match base without VS against whitelist entries that include VS
      let matched = ok;
      if (!matched) {
        for (const w of EMOJI_WHITELIST_SET) {
          if (w.replace(/\uFE0F/g, '') === tok.replace(/\uFE0F/g, '')) {
            matched = true;
            break;
          }
        }
      }
      if (!matched) return '';
      if (kept) return '';
      kept = true;
      // prefer canonical whitelist form
      for (const w of EMOJI_WHITELIST) {
        if (w.replace(/\uFE0F/g, '') === tok.replace(/\uFE0F/g, '')) return w;
      }
      return tok;
    });
  };

  let out = opts.recentAssistantHadEmoji ? stripAll(raw) : keepAtMostOneWhitelist(raw);
  out = out.replace(/[ \t]{2,}/g, ' ').replace(/ ?\n ?/g, '\n').trim();

  // If nothing left (was pure emoji), fall back to text-only of original; if still empty, soft ellipsis.
  if (!out) {
    const textOnly = stripAll(raw);
    out = textOnly.trim() || '……';
  }

  // Guard: still no letters/CJK and only emoji somehow → force strip
  const hasWord = /[\u4e00-\u9fffA-Za-z0-9]/.test(out);
  if (!hasWord && hasEmojiToken(out)) {
    const textOnly = stripAll(raw);
    out = textOnly.trim() || '……';
  }

  return out;
}
