/**
 * C-04 白名单；前后端须保持一致
 * Keep in sync with apps/web/src/constants/emojiWhitelist.ts
 * (server copy — web file says the inverse path)
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
  return `【表情符号】可偶尔在句中或句末使用 0～2 个 Unicode 表情，仅限下列符号：${list}
规则：不是每条都用；同一条最多 2 个且不要连刷；禁止白名单外的符号堆砌。活泼/外向人设可稍多，冷静/克制/冷淡人设（如夜见）默认少用或不用。若用户本轮用了表情，可偶尔回一个合拍的白名单表情，不要机械复读同一个。`;
}
