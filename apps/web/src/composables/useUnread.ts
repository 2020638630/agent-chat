/**
 * C-03 conversation unread (nav dot + list badge).
 * D-02 partial extract: totalUnread + mark-read-on-open live here;
 * App only renders. UI-3 badge motion stays CSS (wx-motion-badge).
 * Memory whisper notices live in useMemoryUi — not this composable.
 */
import type { Ref } from 'vue';
import { computed } from 'vue';
import { api, type Conversation } from '../api/client';

export function useUnread(conversations: Ref<Conversation[]>) {
  const totalUnread = computed(() =>
    conversations.value.reduce((sum, c) => sum + (Number(c.unread_count) || 0), 0),
  );

  function clearLocal(conversationId: string) {
    const row = conversations.value.find((c) => c.id === conversationId);
    if (row) row.unread_count = 0;
  }

  function applySynced(conversationId: string, count: number | undefined | null) {
    const live = conversations.value.find((c) => c.id === conversationId);
    if (live) live.unread_count = count ?? 0;
  }

  /** Server marks read on GET messages; clear badge immediately, then soft-sync from list. */
  function markReadOnOpen(conversationId: string) {
    clearLocal(conversationId);
    void api
      .listConversations()
      .then((listRes) => {
        const synced = listRes.conversations.find((c) => c.id === conversationId);
        if (synced) applySynced(conversationId, synced.unread_count);
      })
      .catch(() => {});
  }

  function hasUnread(count: number | undefined | null): boolean {
    return (Number(count) || 0) > 0;
  }

  function badgeText(count: number | undefined | null): string {
    const n = Number(count) || 0;
    if (n <= 0) return '';
    return n > 99 ? '99+' : String(n);
  }

  return {
    totalUnread,
    markReadOnOpen,
    hasUnread,
    badgeText,
  };
}
