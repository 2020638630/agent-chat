/**
 * UI-5: message reactions (multi-emoji toggle + chip state).
 * Keeps reaction busy/toggle out of App.vue; picker chrome stays in msg menu.
 */
import type { Ref } from 'vue';
import { ref } from 'vue';
import { api, type ChatMessage, type MessageReaction } from '../api/client';

/** Quick bar — all in C-04 whitelist. */
export const REACTION_QUICK: readonly string[] = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

export function useMessageReactions(
  messages: Ref<ChatMessage[]>,
  conversationId: Ref<string | null>,
  setStatus: (msg: string) => void,
) {
  const busyKey = ref<string | null>(null);

  async function toggleReaction(messageId: string, emoji: string) {
    const cid = conversationId.value;
    if (!cid || !emoji) return;
    const key = `${messageId}:${emoji}`;
    if (busyKey.value === key) return;
    busyKey.value = key;
    try {
      const res = await api.toggleMessageReaction(cid, messageId, emoji);
      const idx = messages.value.findIndex((m) => m.id === messageId);
      if (idx >= 0) {
        const next = [...messages.value];
        next[idx] = { ...next[idx], reactions: res.reactions as MessageReaction[] };
        messages.value = next;
      }
    } catch {
      setStatus('表情反应失败');
    } finally {
      if (busyKey.value === key) busyKey.value = null;
    }
  }

  return {
    REACTION_QUICK,
    toggleReaction,
  };
}
